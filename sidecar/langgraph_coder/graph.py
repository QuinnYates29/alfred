"""The constrained agent ⇄ tools ⇄ test graph.

The constraint is the point: the model gets ONLY read_file / write_file /
list_dir, all workspace-scoped. No shell. The only thing that decides
success is the acceptance test command run by the `test` node.
"""
import os
import subprocess
from typing import Annotated, Any, Optional, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

TEST_TIMEOUT_S = 600
TEST_OUTPUT_MAX = 3000

SYSTEM = (
    "You are a careful coder working inside one workspace directory. "
    "You may only read, write and list files inside that directory using the "
    "given tools — there is no shell. Files are checked by an external test "
    "command that runs automatically when you stop calling tools. "
    "If the tests fail you will receive their output; fix the files and try again. "
    "Be concise."
)


class State(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    iteration: int          # number of test runs so far
    steps: int              # agent turns used in the current iteration
    last_test_output: str
    test_ok: Optional[bool]
    files_changed: list[str]


def make_tools(workspace: str, files_changed: list):
    """Build the three workspace-scoped tools. Escape attempts return an error string."""
    ws = os.path.realpath(workspace)

    def resolve(path: str) -> Optional[str]:
        p = path if os.path.isabs(path) else os.path.join(ws, path)
        rp = os.path.realpath(p)
        if rp == ws or rp.startswith(ws + os.sep):
            return rp
        return None

    def read_file(path: str) -> str:
        """Read a UTF-8 text file in the workspace. Returns its contents or an error."""
        rp = resolve(path)
        if rp is None:
            return "error: path escapes the workspace"
        if not os.path.isfile(rp):
            return f"error: not a file: {path}"
        try:
            with open(rp, encoding="utf-8", errors="replace") as f:
                return f.read(200_000)
        except OSError as e:
            return f"error: {e}"

    def write_file(path: str, content: str) -> str:
        """Write a UTF-8 text file in the workspace (creates parent dirs)."""
        rp = resolve(path)
        if rp is None:
            return "error: path escapes the workspace"
        try:
            os.makedirs(os.path.dirname(rp) or ws, exist_ok=True)
            with open(rp, "w", encoding="utf-8") as f:
                f.write(content)
            files_changed.append(os.path.relpath(rp, ws))
            return f"wrote {len(content)} chars to {os.path.relpath(rp, ws)}"
        except OSError as e:
            return f"error: {e}"

    def list_dir(path: str = ".") -> str:
        """List a directory in the workspace. One entry per line, '/' suffix for dirs."""
        rp = resolve(path)
        if rp is None:
            return "error: path escapes the workspace"
        if not os.path.isdir(rp):
            return f"error: not a directory: {path}"
        try:
            names = sorted(os.listdir(rp))
            return "\n".join(n + ("/" if os.path.isdir(os.path.join(rp, n)) else "") for n in names) or "(empty)"
        except OSError as e:
            return f"error: {e}"

    return [read_file, write_file, list_dir]


def run_test(workspace: str, test_cmd: str, progress) -> tuple[bool, str]:
    """Run the acceptance command. Returns (ok, output tail ≤ 3000 chars)."""
    progress(f"test: running {test_cmd!r}")
    try:
        proc = subprocess.run(
            ["bash", "-c", test_cmd],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=TEST_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return False, f"test command timed out after {TEST_TIMEOUT_S}s"
    except OSError as e:
        return False, f"test command failed to start: {e}"
    out = (proc.stdout or "") + (proc.stderr or "")
    if len(out) > TEST_OUTPUT_MAX:
        out = out[-TEST_OUTPUT_MAX:]
    return proc.returncode == 0, out


def build_graph(workspace: str, test_cmd: str, base_url: str, model: str,
                max_iterations: int, max_steps_per_iteration: int,
                files_changed: list, progress):
    llm = ChatOpenAI(base_url=base_url.rstrip("/") + "/v1", model=model,
                     api_key="local", max_tokens=4096, temperature=0)
    tools = make_tools(workspace, files_changed)
    llm_with_tools = llm.bind_tools(tools)

    def agent(state: State) -> dict:
        msgs = [SystemMessage(SYSTEM)] + list(state["messages"])
        msg = llm_with_tools.invoke(msgs)
        steps = state.get("steps", 0) + 1
        progress(f"agent: step {steps} (iteration {state.get('iteration', 0) + 1})")
        return {"messages": [msg], "steps": steps}

    def route_after_agent(state: State) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and getattr(last, "tool_calls", None):
            return "tools"
        return "test"

    tool_node = ToolNode(tools)

    def after_tools(state: State) -> str:
        if state.get("steps", 0) >= max_steps_per_iteration:
            progress(f"agent: hit maxStepsPerIteration ({max_steps_per_iteration})")
            return "test"
        return "agent"

    def test(state: State) -> dict:
        ok, out = run_test(workspace, test_cmd, progress)
        iteration = state.get("iteration", 0) + 1
        if ok:
            progress(f"test: PASS (iteration {iteration})")
        else:
            progress(f"test: FAIL (iteration {iteration}/{max_iterations})")
        update: dict = {"iteration": iteration, "test_ok": ok, "last_test_output": out}
        if not ok and iteration < max_iterations:
            update["steps"] = 0
            update["messages"] = [HumanMessage(
                "The test command failed. Output tail:\n" + out[-1500:] +
                "\nFix the files and try again."
            )]
        return update

    def route_after_test(state: State) -> str:
        if state.get("test_ok") or state.get("iteration", 0) >= max_iterations:
            return "end"
        return "agent"

    g = StateGraph(State)
    g.add_node("agent", agent)
    g.add_node("tools", tool_node)
    g.add_node("test", test)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", route_after_agent, {"tools": "tools", "test": "test"})
    g.add_conditional_edges("tools", after_tools, {"agent": "agent", "test": "test"})
    g.add_conditional_edges("test", route_after_test, {"agent": "agent", "end": END})
    return g.compile()

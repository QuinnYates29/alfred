"""The peer-review graph (ALF-7): a fixed, read-only review of one commit.

    [decide: needs a careful review?]  →  START → checks → review_file ⟲ (one changed file per pass, in order) → scope → END  →  [decide: done? safe?]

The two bracketed steps are the decision layer's (/v1/decision on the same model), run by the caller
(src/review/peer.ts) on either side of this graph: when the first one is confidently "safe", the caller
sends reviewFiles=false and the graph only runs the checks.

Determinism is the point, so the shape is fixed and the model only fills a rubric:
- `checks` runs the acceptance command in a fresh clone at the exact commit (code decides pass/fail);
- `review_file` gives the model that file's diff plus READ-ONLY tools (read_file, list_dir — no writes,
  no shell), temperature 0, a bounded number of steps, and asks for one JSON object of issues;
- `scope` asks once whether the whole diff does what the spec asked and nothing else;
- no verdict here: the caller computes it from the checks and the findings (src/review/peer.ts).
An answer that is not valid JSON after one nudge becomes a `major` finding (fail closed).
"""
import json
import re
from typing import Optional, TypedDict

FILE_DIFF_MAX = 12_000
SEVERITIES = ("blocker", "major", "minor")

SYSTEM = (
    "You are a strict code reviewer. You cannot change anything: you may only read and list files "
    "in the workspace (the change is checked out there). Review only what you are asked about. "
    "Report real problems: bugs, missing error handling, security or safety regressions, behaviour "
    "the spec did not ask for, tests weakened to pass. Do not report style. "
    "When done, answer with ONE JSON object and nothing else."
)

FILE_ASK = (
    "Spec of the change:\n{spec}\n\nReview this file's diff. Read other files if you need context.\n"
    "File: {path}\n```diff\n{diff}\n```\n"
    'Answer: {{"issues": [{{"severity": "blocker|major|minor", "line": <int or null>, "what": "<one sentence>"}}]}} '
    '— an empty list if the file is fine.'
)

SCOPE_ASK = (
    "Spec of the change:\n{spec}\n\nChanged files:\n{files}\n\n"
    "Does this change do what the spec asks, and does it change anything the spec did not ask for?\n"
    'Answer: {{"addresses_spec": true|false, "out_of_scope": ["<path>", ...], "why": "<one sentence>"}}'
)


class State(TypedDict, total=False):
    index: int
    checks_ok: bool
    checks_output: str
    findings: list
    reviewed: list


def parse_json(text: str) -> Optional[dict]:
    """The last {...} object in a model answer, or None. Tolerates ```json fences and prose around it."""
    t = re.sub(r"```(?:json)?", "", str(text or ""))
    start = t.find("{")
    while start >= 0:
        depth = 0
        for i in range(start, len(t)):
            if t[i] == "{":
                depth += 1
            elif t[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(t[start:i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except ValueError:
                        break
                    break
        start = t.find("{", start + 1)
    return None


def file_issues(obj: Optional[dict], path: str) -> list:
    """Normalise one file's answer into findings; an unusable answer is a `major` finding (fail closed)."""
    if not obj or not isinstance(obj.get("issues"), list):
        return [{"file": path, "severity": "major", "line": None, "what": "reviewer gave no usable verdict for this file"}]
    out = []
    for it in obj["issues"]:
        if not isinstance(it, dict):
            continue
        sev = str(it.get("severity", "")).lower()
        line = it.get("line")
        out.append({
            "file": path,
            "severity": sev if sev in SEVERITIES else "major",
            "line": line if isinstance(line, int) else None,
            "what": str(it.get("what", ""))[:500],
        })
    return out


def scope_issues(obj: Optional[dict]) -> list:
    if not obj or not isinstance(obj.get("addresses_spec"), bool):
        return [{"file": None, "severity": "major", "line": None, "what": "reviewer gave no usable scope verdict"}]
    out = []
    if not obj["addresses_spec"]:
        out.append({"file": None, "severity": "major", "line": None, "what": "does not do what the spec asked: " + str(obj.get("why", ""))[:400]})
    for p in obj.get("out_of_scope") or []:
        out.append({"file": str(p), "severity": "major", "line": None, "what": "changed but not asked for by the spec"})
    return out


def split_diff(diff: str) -> dict:
    """{path: that file's part of a unified git diff}."""
    parts: dict = {}
    cur = None
    for line in str(diff or "").splitlines(keepends=True):
        m = re.match(r"^diff --git a/(.+?) b/(.+?)\s*$", line)
        if m:
            cur = m.group(2)
            parts[cur] = ""
        if cur is not None:
            parts[cur] += line
    return parts


def build_review_graph(workspace: str, test_cmd: str, base_url: str, model: str, spec: str,
                       files: list, diff: str, max_steps: int, progress, review_files: bool = True):
    # late imports: venv-heavy (the helpers above run on a bare python3)
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    from langchain_openai import ChatOpenAI
    from langgraph.graph import END, START, StateGraph

    from .graph import make_tools, run_test

    # 8k: the model thinks before it answers; at 2k the thinking used the whole budget and no JSON came out.
    llm = ChatOpenAI(base_url=base_url.rstrip("/") + "/v1", model=model,
                     api_key="local", max_tokens=8192, temperature=0)
    read_file, _write_file, list_dir = make_tools(workspace, [])
    tools = {"read_file": read_file, "list_dir": list_dir}  # read-only: write_file is never bound
    llm_tools = llm.bind_tools([read_file, list_dir])
    per_file = split_diff(diff)

    def ask(prompt: str) -> Optional[dict]:
        """A bounded read-only tool loop that must end in one JSON object. The last step takes the tools away
        and demands the answer: the model otherwise kept reading files until it ran out of steps (no verdict)."""
        msgs: list = [SystemMessage(SYSTEM), HumanMessage(prompt)]
        nudged = False
        for step in range(max_steps):
            last = step == max_steps - 1
            if last:
                msgs.append(HumanMessage("No more reading. Answer now with the JSON object only."))
            msg = (llm if last else llm_tools).invoke(msgs)
            msgs.append(msg)
            calls = [] if last else (getattr(msg, "tool_calls", None) or [])
            if calls:
                for c in calls:
                    fn = tools.get(c.get("name"))
                    out = fn(**(c.get("args") or {})) if fn else "error: only read_file and list_dir exist"
                    msgs.append(ToolMessage(content=str(out)[:20_000], tool_call_id=c.get("id", "")))
                continue
            obj = parse_json(msg.content if isinstance(msg, AIMessage) else "")
            if obj is not None or nudged or last:
                return obj
            nudged = True
            msgs.append(HumanMessage("Answer with the JSON object only."))
        return None

    def checks(state: State) -> dict:
        ok, out = run_test(workspace, test_cmd, progress)
        progress(f"checks: {'PASS' if ok else 'FAIL'}")
        return {"checks_ok": ok, "checks_output": out, "index": 0, "findings": [], "reviewed": []}

    def review_file(state: State) -> dict:
        i = state.get("index", 0)
        path = files[i]
        progress(f"review: {path} ({i + 1}/{len(files)})")
        d = per_file.get(path, "")
        if len(d) > FILE_DIFF_MAX:
            d = d[:FILE_DIFF_MAX] + "\n… (diff truncated; read the file for the rest)"
        found = file_issues(ask(FILE_ASK.format(spec=spec[:4000], path=path, diff=d)), path)
        return {"index": i + 1, "findings": state.get("findings", []) + found, "reviewed": state.get("reviewed", []) + [path]}

    def scope(state: State) -> dict:
        progress("review: scope")
        found = scope_issues(ask(SCOPE_ASK.format(spec=spec[:4000], files="\n".join(files))))
        return {"findings": state.get("findings", []) + found}

    def next_after(state: State) -> str:
        if not review_files:
            return "end"  # the decision layer judged the diff confidently safe: checks only
        return "review_file" if state.get("index", 0) < len(files) else "scope"

    g = StateGraph(State)
    g.add_node("checks", checks)
    g.add_node("review_file", review_file)
    g.add_node("scope", scope)
    g.add_edge(START, "checks")
    g.add_conditional_edges("checks", next_after, {"review_file": "review_file", "scope": "scope", "end": END})
    g.add_conditional_edges("review_file", next_after, {"review_file": "review_file", "scope": "scope"})
    g.add_edge("scope", END)
    return g.compile()


def run_review(req: dict, progress) -> dict:
    """stdin request (mode 'review') → the one final JSON line."""
    files = [str(f) for f in (req.get("files") or [])]
    result = {"ok": False, "checksOk": False, "checksOutput": "", "findings": [], "reviewed": []}
    try:
        graph = build_review_graph(
            str(req.get("workspace", "")), str(req.get("testCmd", "")),
            str(req.get("baseUrl", "http://127.0.0.1:1110")), str(req.get("model", "qwen3.8-flash-next")),
            str(req.get("spec", "")), files, str(req.get("diff", "")), int(req.get("maxStepsPerFile", 8)), progress,
            review_files=req.get("reviewFiles", True) is not False,
        )
        final = graph.invoke({}, config={"recursion_limit": 4 * len(files) + 20})
        result.update(ok=True, checksOk=bool(final.get("checks_ok")), checksOutput=str(final.get("checks_output", ""))[-3000:],
                      findings=final.get("findings", []), reviewed=final.get("reviewed", []))
    except Exception as e:  # noqa: BLE001 — the one final line must still be printed
        progress(f"error: {type(e).__name__}: {e}")
        result["error"] = f"{type(e).__name__}: {e}"[:3000]
    return result


if __name__ == "__main__":  # pure-helper self-check: python3 -m langgraph_coder.review (no venv needed)
    assert parse_json('sure ```json\n{"issues": []}\n```') == {"issues": []}
    assert parse_json("no json here") is None
    assert file_issues(None, "a.ts")[0]["severity"] == "major"
    assert file_issues({"issues": [{"severity": "weird", "what": "x"}]}, "a.ts")[0]["severity"] == "major"
    assert scope_issues({"addresses_spec": True, "out_of_scope": ["b.ts"]})[0]["file"] == "b.ts"
    assert list(split_diff("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n-2\n")) == ["x", "y"]
    print("ok")

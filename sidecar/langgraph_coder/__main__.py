"""Entry point: `python -m langgraph_coder`.

stdin  = one JSON object {task, workspace, testCmd, maxIterations, baseUrl,
                          model, maxStepsPerIteration?, bridgeUrl?, bridgeToken?}
stderr = JSON lines {"progress": "<msg>"} (flushed)
stdout = exactly one final JSON line
         {"ok": bool, "iterations": int, "testOutput": str<=3000, "filesChanged": [str]}

mode "review" (ALF-7, review.py): stdin {mode, workspace, testCmd, baseUrl, model, spec, files, diff,
maxStepsPerFile?} → {"ok": ran, "checksOk", "checksOutput", "findings": [{file, severity, line, what}], "reviewed", "error"?}
"""
import json
import sys


def progress(msg: str) -> None:
    sys.stderr.write(json.dumps({"progress": str(msg)}) + "\n")
    sys.stderr.flush()


def emit(result: dict) -> None:
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()


def main() -> int:
    req = json.load(sys.stdin)
    if req.get("mode") == "review":
        from .review import run_review
        emit(run_review(req, progress))
        return 0
    task = str(req.get("task", ""))
    workspace = str(req.get("workspace", ""))
    test_cmd = str(req.get("testCmd", ""))
    max_iterations = int(req.get("maxIterations", 6))
    base_url = str(req.get("baseUrl", "http://127.0.0.1:1110"))
    model = str(req.get("model", "qwen3.8-flash-next"))
    max_steps = int(req.get("maxStepsPerIteration", 20))
    bridge_url = req.get("bridgeUrl") or None

    files_changed: list[str] = []
    result = {"ok": False, "iterations": 0, "testOutput": "", "filesChanged": files_changed}

    from . import graph as _graph  # late import: venv-heavy
    from .graph import TEST_OUTPUT_MAX, build_graph
    _graph.BRIDGE_TOKEN = req.get("bridgeToken") or None

    try:
        progress(f"start: task on {workspace} (model={model}, maxIterations={max_iterations})")
        graph = build_graph(workspace, test_cmd, base_url, model,
                            max_iterations, max_steps, files_changed, progress,
                            bridge_url=bridge_url)
        final = graph.invoke(
            {"messages": [("user", task)], "iteration": 0, "steps": 0,
             "files_changed": []},
            config={"recursion_limit": 1000},
        )
        result["iterations"] = int(final.get("iteration", 0))
        result["ok"] = bool(final.get("test_ok"))
        out = str(final.get("last_test_output", ""))
        result["testOutput"] = out[-TEST_OUTPUT_MAX:]
    except Exception as e:  # noqa: BLE001 — the one final line must still be printed
        progress(f"error: {type(e).__name__}: {e}")
        result["testOutput"] = f"{type(e).__name__}: {e}"[:TEST_OUTPUT_MAX]

    result["testOutput"] = str(result["testOutput"])[:TEST_OUTPUT_MAX]
    # de-dupe, keep order
    seen = set()
    result["filesChanged"] = [f for f in files_changed if not (f in seen or seen.add(f))]
    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())

You are a senior TypeScript engineer implementing part of the `alfred` agent platform in the current directory (a git worktree; Node 22, ESM, imports use `.js` suffixes, vitest for tests). Use the global `fetch` (Node 22) — no extra HTTP libraries.

Read first: CLAUDE.md, docs/phases/P1-agent-runtime.md (section openai.ts), src/runtime/contract.ts.

YOUR SCOPE (only this file): src/runtime/openai.ts exporting openaiLLM(...) and limitLLM(...).

Contract test you must make pass (DO NOT edit test/acceptance/ or src/runtime/contract.ts):
  npx vitest run test/acceptance/p1/openai.test.ts

Requirements:
- POST `${baseUrl}/chat/completions` JSON {model, messages, tools?, max_tokens?, temperature?}. Omit `tools` when the list is empty.
- messages: first {role:'system', content: system}; user → {role:'user', content}; assistant → {role:'assistant', content, tool_calls:[{id, type:'function', function:{name, arguments: JSON.stringify(args)}}]} (omit tool_calls when none); tool → {role:'tool', tool_call_id, content}.
- tools → [{type:'function', function:{name, description, parameters}}].
- Response: choices[0].message. content = (content ?? '') with every <think>...</think> block removed and trimmed. toolCalls from tool_calls: args = JSON.parse(arguments) or {__raw: arguments} on failure. usage → {promptTokens: prompt_tokens ?? 0, completionTokens: completion_tokens ?? 0}.
- Non-2xx → throw new Error(`LLM HTTP ${status}: ${body.slice(0,300)}`).
- Honour req.signal plus timeoutMs (default 15 min) using AbortSignal.any([...]).
- limitLLM(llm, n): FIFO semaphore around chat(); returns object with chat, active(), queued(). A queued call whose req.signal aborts is removed from the queue and rejects with an AbortError.

Work method: write the code, run the test, fix until green. Also make `npx tsc --noEmit -p . 2>&1 | grep src/runtime/openai` show no errors. Reply with a short summary and the final test result.

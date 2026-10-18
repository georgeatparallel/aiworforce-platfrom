# Live web search

Hawk and Scout can use `search_web` for current market or competitor research.
On an unconfigured installation it uses [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
at `https://search.parallel.ai/mcp`, with no account or API key. Anonymous search
uses Fast mode. Search excerpts and source URLs reach the agent's answer context;
the agent is instructed to cite those URLs and treat source text as evidence.

Ask Pilot a topic question such as “What's happening in the AI recruiting market?”
and start the proposed research plan. The existing plan confirmation and Hawk/Scout
tool permissions still apply. Model generation uses the deployment's existing model
configuration. Direct URL extraction continues to use Firecrawl.

## Deployment settings

These variables belong on the server, never in `VITE_*` configuration.

| Setting | Behavior |
| --- | --- |
| No search settings | Anonymous Parallel search |
| `ENABLE_SEARCH_WEB=false` | Search disabled, including an explicit Parallel selection |
| `SEARCH_WEB_PROVIDER=parallel` | Explicitly select anonymous Parallel |
| Another `SEARCH_WEB_PROVIDER` | Unavailable; no fallback to Parallel |
| Existing `SEARCH_WEB_API_KEY` or `GEMINI_SEARCH` | Preserve that choice as unavailable until its backend is implemented; set `SEARCH_WEB_PROVIDER=parallel` to switch deliberately |

No configured provider key is sent to Parallel. A failed search, timeout or quota
response does not trigger another provider. Free anonymous usage has rate limits;
the agent receives a failure notice when no current web evidence was retrieved.
The MCP operation has a 20-second deadline and follows request cancellation.
Search returns at most 10 cited results; `max_results` can lower that limit.

The retired `research_web` tool remains retired. Lead sourcing, paid provider
budgets, model accounting and email approval are unchanged.

# V3.1 provider API review — 2026-11-17

## Decision: LIVE Generate remains locked

No paid API request, model generation, AI credit usage or Google Flow account automation was performed. Manual file import is implemented; it is not an API integration and does not certify the provenance of imported media.

| Subject | Official source attempted | Observed result | Conclusion |
| --- | --- | --- | --- |
| Google image-generation API / possible Nano Banana Pro mapping | https://ai.google.dev/gemini-api/docs/image-generation | Cloud proxy CONNECT 403, HTTP application response 000 | **UNKNOWN** current model IDs, Nano Banana Pro mapping, access rules, pricing and quotas. The URL is a documentation candidate, not proof of capability. |
| Google video-generation API | https://ai.google.dev/gemini-api/docs/video | Cloud proxy CONNECT 403, HTTP application response 000 | **UNKNOWN** current supported video models/endpoints. Cannot infer Omni Flash/Plus support. |
| Google Flow product | https://support.google.com/flow/ | Cloud proxy CONNECT 403, HTTP application response 000 | **UNKNOWN** current product features/API access. A Flow UI is not evidence of a developer API. |
| Omni Flash / Omni Plus | No vendor identity or official developer documentation was supplied and no web-search connector is available in this session | Vendor/model mapping unverified | **UNKNOWN** supplier, official API, compatibility with Google Flow, credentials, license and cost. UI names are user-selected import labels only. |

**VERIFIED, local code:** `server/providers.mjs` has no network/billing client; LIVE generation rejects with HTTP 501. Environment variable-name inspection found no Gemini/Google model key/Omni/Nano credential binding in this process. This does not establish the user's external account permissions. No credentials were printed.

Before any future direct Generate integration, require all of:

1. Read current official vendor documentation; establish model identity, endpoint, authentication, terms and media format support.
2. Verify authorized account/model access without generating billable media.
3. Establish an enforceable cost budget, request limits, usage records and explicit authorization. This order's budget is zero AI credits, so billable generation stays disabled.
4. Keep keys server-side; do not automate a browser UI as an undocumented API or rotate accounts to evade limits.

None of those missing conditions was assumed satisfied. There is no adapter URL configuration that can accidentally activate a paid API in this branch.

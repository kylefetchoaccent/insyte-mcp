# Test fixtures

Insyte's public schema documents, fetched without an API key on 2026-11-02. They hold no
customer data. Use them in mock-server tests so field names, keys and navigations match the
real API instead of being invented.

| File | Source |
|---|---|
| `us-v2-metadata.xml` | `https://api.myinsyte.com/v2/$metadata` |
| `us-openapi-v2.json` | `https://api.myinsyte.com/openapi.v2.json` |
| `au-v2-metadata.xml` | `https://api.myinsyte.com.au/v2/$metadata` |
| `au-openapi-v2.json` | `https://api.myinsyte.com.au/openapi.v2.json` |

Neither host offered `/v3/$metadata` on that date (both returned 404).

Schema is not tenant data. Code values, row counts and which columns a tenant's database
actually holds still need a live key to check.

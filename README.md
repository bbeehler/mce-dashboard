# MCE Executive Dashboard

One page for AIA Canada's Marketing, Communications and Events results across AIA Canada, CCIF, YPA and I-CAR.

Site: https://bbeehler.github.io/mce-dashboard/

## Sections and sources

| Section | Source | How it updates |
|---|---|---|
| Events | PheedLoop REST API | Every 15 minutes (once connected) |
| Marketing: website | GA4 Data API | Daily (once connected) |
| Communications: email | Insightly Marketing exports | Monthly export added to `data/` (Insightly's API has no marketing email data) |
| Communications: send plan | `eblast-calendar/data.json` | Live, read from the eBlast calendar |
| Communications: social | Social scheduling tool | Daily (once connected) |

Each file in `data/` carries a `status`: `sample` (placeholder numbers), `audit` (2026 email send audit) or `live`. The page labels every section accordingly.

## Secrets (Settings → Secrets and variables → Actions)

- `PHEEDLOOP_API_KEY` (and `PHEEDLOOP_API_SECRET` / `PHEEDLOOP_ORG` if PheedLoop issues them)
- `GA4_CREDENTIALS`: the service account JSON key; the service account needs Viewer access on each GA4 property

Settings → Pages → Source must be **GitHub Actions**.

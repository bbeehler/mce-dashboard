# MCE Executive Dashboard

Monthly Marketing, Communications and Engagement (Events) results for AIA Canada overall, with month-over-month and year-over-year comparisons.

- Dashboard: https://bbeehler.github.io/mce-dashboard/
- Upload a month: https://bbeehler.github.io/mce-dashboard/upload.html

## How it works

1. Each month, fill in `template/MCE-monthly-data-template.xlsx` (also downloadable from the upload page). Totals only: no personal information.
2. Sign in on the upload page with an approved email (a one-time link is emailed to you), choose the file, check the preview and save.
3. The numbers are stored in the **MCE Dashboard** Supabase project and the dashboard shows them immediately. Uploading a month again replaces the numbers it contains; blank cells never overwrite saved numbers.

The send plan card reads the live eBlast calendar (`../eblast-calendar/data.json`).

## Supabase tables

| Table | Holds |
|---|---|
| `metric_values` | One row per month × source × metric (× breakdown such as channel or platform). Brand is always `All`: the dashboard reports overall numbers only. |
| `events` | Event code, name, brand, dates, capacity, targets, and last year's event code |
| `event_snapshots` | Registrations, revenue and attendance at each month end, per event |
| `targets` | Annual targets by stream, brand and metric |
| `admins` | Emails allowed to upload |
| `uploads` | Upload history |

Anyone can read the totals; only emails in `admins` can write (row level security).

To approve another uploader, run in the Supabase SQL editor:
`insert into admins (email) values ('name@aiacanada.com');`

January to September 2026 email figures were loaded from the 2026 email send audit.

# notify

Transactional email: the Postmark client (over `fetch`, no SDK) and the templates.

**What lives here:** sign-in magic links, the daily merchant summary, and the alerts a merchant
must see (spending cap reached, plan frozen, a complaint). Templates are plain functions that
return subject + text + HTML.

Without `POSTMARK_TOKEN` the mailer collects messages in memory instead of sending, so local
development and tests never email a real person.

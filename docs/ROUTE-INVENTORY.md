# Application route inventory

Generated from the root App Router with `node scripts/route-inventory.mjs`. These are declarations, not live endpoint checks. Implicit framework methods are not counted.

## Pages (5)

- `/`
- `/contact`
- `/dashboard`
- `/login`
- `/marketingos`

## API routes (316)

| Path | Explicit HTTP exports |
| --- | --- |
| `/api` | GET |
| `/api/activity` | GET |
| `/api/activity-feed` | GET |
| `/api/agentos/agents` | GET |
| `/api/agentos/command` | POST |
| `/api/agentos/health/deep` | GET |
| `/api/agents` | GET |
| `/api/ai-agents` | GET, PATCH |
| `/api/ai/agents/[id]/run` | POST |
| `/api/ai/auto-reply` | POST |
| `/api/ai/avatar` | GET, POST |
| `/api/ai/avatar-video` | POST |
| `/api/ai/chat` | GET, POST |
| `/api/ai/cinematic-video` | POST |
| `/api/ai/context` | GET |
| `/api/ai/diagram` | POST |
| `/api/ai/generate-content` | POST |
| `/api/ai/generate-image` | POST |
| `/api/ai/generate-video` | POST |
| `/api/ai/grammar-check` | POST |
| `/api/ai/humanize` | POST |
| `/api/ai/local-status` | GET |
| `/api/ai/memory` | GET, POST |
| `/api/ai/video-status` | GET |
| `/api/ai/voice` | POST |
| `/api/analytics` | GET |
| `/api/announcements` | GET, POST |
| `/api/announcements/[id]` | PATCH, DELETE |
| `/api/approvals` | GET, POST |
| `/api/asr-transcribe` | GET, POST |
| `/api/assignments` | GET, POST |
| `/api/assignments/[id]` | GET, PATCH, DELETE |
| `/api/assignments/[id]/submissions` | GET |
| `/api/attendance` | GET, POST |
| `/api/audit` | GET |
| `/api/audit-logs` | GET |
| `/api/auth/[...nextauth]` | GET, POST |
| `/api/auth/login` | POST |
| `/api/auth/me` | GET |
| `/api/auth/otp/config` | GET |
| `/api/auth/otp/send` | POST |
| `/api/auth/register` | POST |
| `/api/avatar-video` | GET, POST, DELETE |
| `/api/avatar-video/file` | GET |
| `/api/backups` | GET, POST |
| `/api/batches` | GET, POST |
| `/api/batches/[id]` | GET, PATCH, DELETE |
| `/api/calendar` | GET |
| `/api/campaigns` | GET, POST |
| `/api/campaigns/[id]` | PATCH, DELETE |
| `/api/command` | POST |
| `/api/comments` | GET, POST |
| `/api/companies` | GET, POST |
| `/api/competitors` | GET, POST |
| `/api/competitors/[id]` | PATCH, DELETE |
| `/api/contact` | GET, POST |
| `/api/content` | GET, POST |
| `/api/content/[id]` | PATCH, DELETE |
| `/api/content/brief` | POST |
| `/api/content/generate` | POST |
| `/api/content/package` | GET |
| `/api/costs` | GET |
| `/api/crm/campaigns` | GET, POST |
| `/api/crm/clients` | GET, POST |
| `/api/crm/contacts` | GET, POST |
| `/api/crm/contacts/[id]` | PATCH, DELETE |
| `/api/crm/deals` | GET, POST |
| `/api/crm/deals/[id]` | PATCH, DELETE |
| `/api/crm/invoices` | GET, POST |
| `/api/crm/leads` | GET, POST |
| `/api/crm/leads/[id]` | GET, PATCH, DELETE |
| `/api/crm/leads/[id]/activities` | POST |
| `/api/crm/projects` | GET, POST |
| `/api/crm/quotes` | GET, POST |
| `/api/crm/quotes/[id]` | PATCH, DELETE |
| `/api/crm/tickets` | GET, POST |
| `/api/crm/tickets/[id]` | PATCH, DELETE |
| `/api/cron/social-publish` | GET |
| `/api/dashboard` | GET |
| `/api/departments` | GET, POST |
| `/api/departments/[id]` | GET, PATCH, DELETE |
| `/api/designations` | GET, POST |
| `/api/designations/[id]` | GET, PATCH, DELETE |
| `/api/diagrams` | GET, POST |
| `/api/email/test` | GET, POST |
| `/api/employees` | GET, POST |
| `/api/employees/[id]` | GET, PATCH, DELETE |
| `/api/exams` | GET, POST |
| `/api/exams/[id]` | GET, PATCH, DELETE |
| `/api/exams/[id]/results` | GET |
| `/api/expenses` | GET, POST |
| `/api/expenses/[id]` | GET, PUT, DELETE |
| `/api/export` | GET |
| `/api/family` | GET, POST |
| `/api/family-projects` | GET, POST |
| `/api/family-studio` | GET, POST |
| `/api/family/clone` | GET, POST |
| `/api/fee-structures` | GET, POST |
| `/api/fee-structures/[id]` | GET, PATCH, DELETE |
| `/api/feeds/import` | POST |
| `/api/feeds/items` | GET |
| `/api/feeds/refresh` | POST |
| `/api/feeds/sources` | GET, POST |
| `/api/feeds/sources/[id]` | DELETE |
| `/api/fees` | GET, POST |
| `/api/fees/[id]` | GET, PATCH, DELETE |
| `/api/growth` | GET, POST |
| `/api/health` | GET |
| `/api/human-avatars` | GET, POST, DELETE |
| `/api/ideas` | GET, POST, DELETE |
| `/api/image-studio` | GET, POST |
| `/api/images/generate` | POST |
| `/api/inkbox` | GET, POST |
| `/api/institution` | GET, POST |
| `/api/keywords` | GET, POST |
| `/api/keywords/[id]` | DELETE |
| `/api/leads/[id]/enrich` | POST |
| `/api/leads/enrich` | GET, POST |
| `/api/leads/export` | GET |
| `/api/leads/import` | POST |
| `/api/learning` | GET |
| `/api/leave` | GET, POST |
| `/api/leave-types` | GET, POST |
| `/api/leave-types/[id]` | GET, PATCH, DELETE |
| `/api/leave/[id]` | GET, PATCH, DELETE |
| `/api/leave/mine` | GET, POST |
| `/api/market-intelligence` | GET |
| `/api/marketing/email-draft` | POST |
| `/api/marketing/humanize` | POST |
| `/api/marketing/leads` | GET, POST |
| `/api/media/audio/[id]` | GET |
| `/api/media/scene/[id]` | GET |
| `/api/media/subtitle/[id]` | GET |
| `/api/media/thumbnail/[id]` | GET |
| `/api/media/video/[id]` | GET |
| `/api/messages` | GET, POST |
| `/api/messages/[id]` | GET |
| `/api/messages/[id]/read` | POST |
| `/api/music/generate` | POST |
| `/api/notifications` | GET, POST |
| `/api/notifications/[id]/read` | POST |
| `/api/notifications/read-all` | POST |
| `/api/og-image` | GET |
| `/api/openapi.json` | GET |
| `/api/otp` | GET, POST |
| `/api/partners` | GET, POST |
| `/api/partners/[id]` | GET, PATCH, DELETE |
| `/api/payments` | GET, POST |
| `/api/payments/[id]` | GET, PATCH, DELETE |
| `/api/programs` | GET, POST |
| `/api/programs/[id]` | GET, PATCH, DELETE |
| `/api/protective-review` | POST |
| `/api/publish` | POST |
| `/api/publishing` | GET, POST |
| `/api/rag/ingest` | GET, POST |
| `/api/rag/search` | POST |
| `/api/recovery/sweep` | GET, POST |
| `/api/salary` | GET, POST |
| `/api/salary/[id]` | GET, PATCH, DELETE |
| `/api/schedule` | GET, POST |
| `/api/schedule/[id]` | GET, PATCH, DELETE |
| `/api/scraper` | POST |
| `/api/seed` | POST |
| `/api/seo` | GET, POST |
| `/api/settings` | GET, POST |
| `/api/settings/api-keys` | GET, POST |
| `/api/settings/api-keys/[id]` | DELETE |
| `/api/settings/company` | GET, PUT |
| `/api/settings/security/password` | POST |
| `/api/settings/sessions` | GET |
| `/api/settings/sessions/[id]` | DELETE |
| `/api/settings/webhooks` | GET, POST |
| `/api/settings/webhooks/[id]` | DELETE |
| `/api/sms/broadcast` | POST |
| `/api/sms/messages` | GET |
| `/api/sms/otp` | GET, POST |
| `/api/sms/otp/verify` | POST |
| `/api/sms/send` | POST |
| `/api/sms/templates` | GET |
| `/api/social` | GET, POST |
| `/api/social-accounts` | GET, POST, DELETE |
| `/api/social/inbox` | GET |
| `/api/students` | GET, POST |
| `/api/students/[id]` | GET, PATCH, DELETE |
| `/api/subjects` | GET, POST |
| `/api/subjects/[id]` | GET, PATCH, DELETE |
| `/api/team` | GET, POST |
| `/api/telegram` | GET, POST |
| `/api/tools` | GET, POST |
| `/api/tools/[id]` | GET, PATCH, DELETE |
| `/api/users` | GET, POST |
| `/api/users/[id]` | GET, PATCH, DELETE |
| `/api/v1/admin/ai-models/after-hours` | GET, PUT |
| `/api/v1/admin/ai-models/agent-assignments` | GET, POST |
| `/api/v1/admin/ai-models/agent-assignments/[agentType]` | DELETE |
| `/api/v1/admin/ai-models/audit` | GET |
| `/api/v1/admin/ai-models/chain` | GET |
| `/api/v1/admin/ai-models/providers` | GET, POST |
| `/api/v1/admin/ai-models/providers/[providerId]` | GET, PATCH, DELETE |
| `/api/v1/admin/ai-models/providers/[providerId]/breaker` | POST |
| `/api/v1/admin/ai-models/providers/[providerId]/discover-models` | POST |
| `/api/v1/admin/ai-models/providers/[providerId]/models` | POST |
| `/api/v1/admin/ai-models/providers/[providerId]/models/[modelId]` | PATCH, DELETE |
| `/api/v1/admin/ai-models/usage` | GET |
| `/api/v1/admin/contact-center-status` | GET |
| `/api/v1/admin/sms-providers` | GET |
| `/api/v1/admin/social-providers` | GET |
| `/api/v1/admin/telephony-status` | GET |
| `/api/v1/admin/voice-engine-status` | GET |
| `/api/v1/admin/voice-foundation` | GET |
| `/api/v1/agent-status` | GET, POST |
| `/api/v1/agents/bounded-loop` | POST |
| `/api/v1/agents/integration-setup` | POST |
| `/api/v1/api-keys` | GET |
| `/api/v1/asr` | POST |
| `/api/v1/auth/logout` | POST |
| `/api/v1/auth/mfa/disable` | POST |
| `/api/v1/auth/mfa/setup` | POST |
| `/api/v1/auth/mfa/verify` | POST |
| `/api/v1/auth/refresh` | POST |
| `/api/v1/billing/adjustments` | POST |
| `/api/v1/billing/credits` | GET, POST |
| `/api/v1/billing/credits/purchase` | POST |
| `/api/v1/billing/invoices` | GET, POST |
| `/api/v1/billing/payments` | POST |
| `/api/v1/billing/plans` | GET, POST |
| `/api/v1/billing/subscribe` | POST |
| `/api/v1/billing/usage` | GET |
| `/api/v1/call-queues` | GET, POST |
| `/api/v1/calls` | GET |
| `/api/v1/calls/[id]` | GET |
| `/api/v1/calls/[id]/analytics` | GET |
| `/api/v1/calls/[id]/answer` | POST |
| `/api/v1/calls/[id]/hangup` | POST |
| `/api/v1/calls/[id]/hold` | POST |
| `/api/v1/calls/[id]/recording` | GET |
| `/api/v1/calls/[id]/resume` | POST |
| `/api/v1/calls/[id]/start-recording` | POST |
| `/api/v1/calls/[id]/summary` | GET |
| `/api/v1/calls/[id]/transfer` | POST |
| `/api/v1/calls/originate` | POST |
| `/api/v1/consent` | GET, POST |
| `/api/v1/customers` | GET, POST |
| `/api/v1/customers/[id]` | GET, PATCH, DELETE |
| `/api/v1/customers/[id]/timeline` | GET |
| `/api/v1/integrations/[provider]/authorize` | POST |
| `/api/v1/integrations/[provider]/callback` | GET |
| `/api/v1/integrations/[provider]/connections/[connectionId]/discover` | POST |
| `/api/v1/integrations/[provider]/connections/[connectionId]/missing-fields` | GET |
| `/api/v1/integrations/[provider]/connections/[connectionId]/resources` | POST |
| `/api/v1/integrations/[provider]/connections/[connectionId]/status` | GET |
| `/api/v1/integrations/[provider]/connections/[connectionId]/validate` | POST |
| `/api/v1/integrations/[provider]/credentials` | POST |
| `/api/v1/ivr-menus` | GET, POST |
| `/api/v1/ivr-menus/[id]` | GET, PATCH, DELETE |
| `/api/v1/knowledge-bases` | GET, POST |
| `/api/v1/knowledge-bases/[id]/documents` | POST |
| `/api/v1/knowledge-bases/[id]/documents/[docId]/reindex` | POST |
| `/api/v1/knowledge-bases/[id]/search` | POST |
| `/api/v1/outbound-campaigns` | GET, POST |
| `/api/v1/outbound-campaigns/[id]` | GET, PATCH, DELETE |
| `/api/v1/outbound-campaigns/[id]/launch` | POST |
| `/api/v1/outbound-campaigns/[id]/pause` | POST |
| `/api/v1/phone-numbers` | GET, POST |
| `/api/v1/phone-numbers/[id]` | GET, PATCH, DELETE |
| `/api/v1/phone-numbers/[id]/assign` | POST |
| `/api/v1/phone-numbers/[id]/release` | POST |
| `/api/v1/projects/[projectId]/integration-setup/confirm` | POST |
| `/api/v1/pronunciation-dictionaries` | GET, POST |
| `/api/v1/ring-groups` | GET, POST |
| `/api/v1/session` | GET |
| `/api/v1/shared-inbox` | GET, POST |
| `/api/v1/shared-inbox/[id]` | PATCH |
| `/api/v1/social/posts` | GET |
| `/api/v1/social/publish` | POST |
| `/api/v1/supervisor/agents` | GET |
| `/api/v1/supervisor/barge-in/[callId]` | POST |
| `/api/v1/supervisor/listen/[callId]` | POST |
| `/api/v1/supervisor/whisper/[callId]` | POST |
| `/api/v1/tts` | POST |
| `/api/v1/tts/stream` | POST |
| `/api/v1/voice-agents` | GET, POST |
| `/api/v1/voice-agents/[id]` | GET, PATCH, DELETE |
| `/api/v1/voice-clone-authorizations` | GET, POST |
| `/api/v1/voice-clone-authorizations/[id]` | POST |
| `/api/v1/voice-clone-authorizations/[id]/revoke` | POST |
| `/api/v1/voice-clone-authorizations/[id]/synthesize` | POST |
| `/api/v1/voice-models` | GET, POST |
| `/api/v1/voicemails` | GET, POST |
| `/api/v1/voicemails/[id]/transcribe` | POST |
| `/api/v1/webhooks` | GET, POST |
| `/api/video/cinematic` | POST |
| `/api/video/from-photo` | GET, POST |
| `/api/video/generate` | POST |
| `/api/video/storyboard` | POST |
| `/api/voice-studio` | GET, POST |
| `/api/voice/generate` | POST |
| `/api/voice/script` | POST |
| `/api/voip/call` | POST |
| `/api/voip/calls` | GET |
| `/api/workflows` | GET, POST |
| `/api/workflows/[id]` | PATCH, DELETE |
| `/api/workflows/execute` | POST |
| `/api/workforce` | GET |
| `/api/workforce/chat` | POST |
| `/api/workforce/conversations` | GET |
| `/api/workforce/conversations/[id]` | GET |
| `/api/workforce/departments` | GET |
| `/api/workforce/employees` | GET |
| `/api/workforce/employees/[id]` | GET, PATCH |
| `/api/workforce/knowledge` | GET |
| `/api/workforce/memory` | GET |
| `/api/workforce/models` | GET |
| `/api/workforce/stats` | GET |
| `/api/workforce/tasks` | GET, POST |
| `/api/workforce/tasks/[id]` | GET |

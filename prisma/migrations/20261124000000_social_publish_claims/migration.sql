-- Durable claim token + lease for concurrent social-publish workers.
-- Additive nullable columns preserve existing content and allow staged rollout.
ALTER TABLE `Content`
  ADD COLUMN `publishClaimToken` VARCHAR(64) NULL,
  ADD COLUMN `publishLeaseUntil` DATETIME(3) NULL,
  ADD INDEX `Content_status_scheduledAt_idx` (`status`, `scheduledAt`);

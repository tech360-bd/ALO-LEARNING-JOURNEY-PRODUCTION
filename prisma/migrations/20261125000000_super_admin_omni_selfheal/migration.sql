-- Super Admin Command Center + OmniRouter + Self-Healing + durable run
-- timelines (additive only). Creates 9 new tables; alters no existing table.
-- Safe for staged rollout: the app degrades gracefully (in-memory fallbacks)
-- until this migration is applied via the standard rehearsal in
-- MIGRATION-RECOVERY-PLAN.md.

CREATE TABLE `SuperAdminConversation` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL DEFAULT 'New conversation',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SuperAdminConversation_updatedAt_idx`(`updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SuperAdminMessage` (
  `id` VARCHAR(191) NOT NULL,
  `conversationId` VARCHAR(191) NOT NULL,
  `role` VARCHAR(191) NOT NULL,
  `content` TEXT NOT NULL,
  `provider` VARCHAR(191) NULL,
  `runId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `SuperAdminMessage_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
  INDEX `SuperAdminMessage_runId_idx`(`runId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `SuperAdminMessage_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `SuperAdminConversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SuperAdminAction` (
  `id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `detail` TEXT NULL,
  `risk` VARCHAR(191) NOT NULL DEFAULT 'safe',
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `payload` TEXT NULL,
  `result` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `decidedAt` DATETIME(3) NULL,
  INDEX `SuperAdminAction_status_createdAt_idx`(`status`, `createdAt`),
  INDEX `SuperAdminAction_kind_createdAt_idx`(`kind`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SelfHealFinding` (
  `id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `severity` VARCHAR(191) NOT NULL DEFAULT 'warn',
  `title` VARCHAR(191) NOT NULL,
  `detail` TEXT NULL,
  `url` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'open',
  `fixKind` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolvedAt` DATETIME(3) NULL,
  INDEX `SelfHealFinding_status_severity_idx`(`status`, `severity`),
  INDEX `SelfHealFinding_kind_createdAt_idx`(`kind`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SelfHealLearning` (
  `id` VARCHAR(191) NOT NULL,
  `pattern` VARCHAR(191) NOT NULL,
  `fixKind` VARCHAR(191) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `successes` INTEGER NOT NULL DEFAULT 0,
  `lastSuccessAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SelfHealLearning_successes_idx`(`successes`),
  UNIQUE INDEX `SelfHealLearning_pattern_key`(`pattern`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OmniProviderHealth` (
  `id` VARCHAR(191) NOT NULL,
  `providerId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'unknown',
  `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
  `consecutiveSuccesses` INTEGER NOT NULL DEFAULT 0,
  `lastLatencyMs` INTEGER NULL,
  `lastError` TEXT NULL,
  `lastCheckedAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `OmniProviderHealth_providerId_key`(`providerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `OmniRouterState` (
  `id` VARCHAR(191) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `value` TEXT NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `OmniRouterState_key_key`(`key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `SuperAdminRun` (
  `id` VARCHAR(191) NOT NULL,
  `ownerId` VARCHAR(191) NOT NULL DEFAULT 'dev-owner',
  `conversationId` VARCHAR(191) NOT NULL,
  `command` TEXT NOT NULL,
  `intent` VARCHAR(191) NOT NULL DEFAULT 'chat',
  `status` VARCHAR(191) NOT NULL DEFAULT 'running',
  `provider` VARCHAR(191) NULL,
  `model` VARCHAR(191) NULL,
  `plan` TEXT NULL,
  `result` TEXT NULL,
  `partialContent` TEXT NULL,
  `pendingActionId` VARCHAR(191) NULL,
  `error` TEXT NULL,
  `seq` INTEGER NOT NULL DEFAULT 0,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SuperAdminRun_ownerId_createdAt_idx`(`ownerId`, `createdAt`),
  INDEX `SuperAdminRun_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SuperAdminRunEvent` (
  `id` VARCHAR(191) NOT NULL,
  `runId` VARCHAR(191) NOT NULL,
  `seq` INTEGER NOT NULL,
  `type` VARCHAR(191) NOT NULL,
  `payload` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `SuperAdminRunEvent_runId_seq_key`(`runId`, `seq`),
  PRIMARY KEY (`id`),
  CONSTRAINT `SuperAdminRunEvent_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `SuperAdminRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

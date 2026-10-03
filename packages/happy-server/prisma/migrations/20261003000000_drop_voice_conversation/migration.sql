-- Voice feature removed: drop the ElevenLabs conversation usage table.
-- DropForeignKey
ALTER TABLE "VoiceConversation" DROP CONSTRAINT "VoiceConversation_accountId_fkey";

-- DropTable
DROP TABLE "VoiceConversation";

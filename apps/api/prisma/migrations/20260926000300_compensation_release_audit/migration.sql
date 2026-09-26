-- Add audit target integrity that was intentionally separated from the main model migration.
ALTER TABLE "AdminProfileAudit" ADD CONSTRAINT "AdminProfileAudit_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

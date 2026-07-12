-- Store timeline metadata in exact integer milliseconds. Existing duration
-- values were whole seconds, so preserve them by scaling during the rename.
ALTER TABLE "AudioNode" RENAME COLUMN "duration" TO "durationMs";
UPDATE "AudioNode" SET "durationMs" = "durationMs" * 1000;

ALTER TABLE "AudioNode" ADD COLUMN "startTimeMs" INTEGER;

-- Backfill the established alternating-track rule for every branch:
-- roots and their direct children start at zero; deeper nodes start at the
-- end of their grandparent (the segment two positions back in that chain).
WITH RECURSIVE "timeline" AS (
  SELECT
    "id",
    "parentId",
    0::INTEGER AS "depth",
    0::INTEGER AS "startTimeMs",
    "durationMs"::INTEGER AS "endTimeMs",
    NULL::INTEGER AS "parentEndTimeMs"
  FROM "AudioNode"
  WHERE "parentId" IS NULL

  UNION ALL

  SELECT
    child."id",
    child."parentId",
    parent_timeline."depth" + 1,
    CASE
      WHEN parent_timeline."depth" = 0 THEN 0
      ELSE parent_timeline."parentEndTimeMs"
    END AS "startTimeMs",
    CASE
      WHEN parent_timeline."depth" = 0 THEN 0
      ELSE parent_timeline."parentEndTimeMs"
    END + child."durationMs" AS "endTimeMs",
    parent_timeline."endTimeMs" AS "parentEndTimeMs"
  FROM "AudioNode" AS child
  INNER JOIN "timeline" AS parent_timeline
    ON child."parentId" = parent_timeline."id"
)
UPDATE "AudioNode" AS node
SET "startTimeMs" = timeline."startTimeMs"
FROM "timeline"
WHERE node."id" = timeline."id";

ALTER TABLE "AudioNode" ALTER COLUMN "startTimeMs" SET NOT NULL;

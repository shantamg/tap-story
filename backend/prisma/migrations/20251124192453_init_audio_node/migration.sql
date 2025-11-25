-- CreateTable
CREATE TABLE "AudioNode" (
    "id" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "parentId" TEXT,
    "duration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioNode_parentId_idx" ON "AudioNode"("parentId");

-- AddForeignKey
ALTER TABLE "AudioNode" ADD CONSTRAINT "AudioNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AudioNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

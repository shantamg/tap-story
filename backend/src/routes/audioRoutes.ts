import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { generateUploadUrl, generateDownloadUrl, deleteAudioFile } from '../services/s3Service';
import { measureLatencyMsForKeys } from '../utils/latencyCalibration';
import { getReplyStartTimeMs } from '../utils/audioTimeline';
import {
  isValidUploadFilename,
  isValidUploadContentType,
  isValidAudioKey,
} from '../utils/audioUploadValidation';

const router = Router();
const prisma = new PrismaClient();
const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

interface SaveAudioPayload {
  key: string;
  durationMs: number;
  parentId: string | null;
}

interface DeletableAudioNode {
  id: string;
  audioUrl: string;
  parentId: string | null;
  _count: { children: number };
}

type DeleteStoryResult =
  | { status: 'not-found' }
  | { status: 'not-leaf' }
  | {
      status: 'deleted';
      nodes: Array<{ id: string; audioUrl: string }>;
      deletedNodes: number;
    };

type DeleteStoryPlan =
  | { status: 'not-found' }
  | { status: 'not-leaf' }
  | { status: 'ready'; nodes: Array<{ id: string; audioUrl: string }> };

async function findExclusiveStorySuffix(
  transaction: Prisma.TransactionClient,
  leafId: string
): Promise<DeleteStoryPlan> {
  const nodes: Array<{ id: string; audioUrl: string }> = [];
  let currentId: string | null = leafId;
  let isTarget = true;

  while (currentId) {
    const node: DeletableAudioNode | null = await transaction.audioNode.findUnique({
      where: { id: currentId },
      select: {
        id: true,
        audioUrl: true,
        parentId: true,
        _count: { select: { children: true } },
      },
    });

    if (!node) return isTarget ? { status: 'not-found' } : { status: 'ready', nodes };
    if (isTarget && node._count.children > 0) return { status: 'not-leaf' };
    if (!isTarget && node._count.children > 1) break;

    nodes.push({ id: node.id, audioUrl: node.audioUrl });
    currentId = node.parentId;
    isTarget = false;
  }

  return { status: 'ready', nodes };
}

function isSerializableWriteConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2034'
  );
}

async function deleteLeafStoryOnce(leafId: string): Promise<DeleteStoryResult> {
  return prisma.$transaction(async transaction => {
    const plan = await findExclusiveStorySuffix(transaction, leafId);
    if (plan.status !== 'ready') return plan;

    const nodeIds = plan.nodes.map(node => node.id);
    const deletion = await transaction.audioNode.deleteMany({
      where: { id: { in: nodeIds } },
    });
    if (deletion.count !== nodeIds.length) {
      throw new Error(`Deleted ${deletion.count} of ${nodeIds.length} audio nodes`);
    }

    return {
      status: 'deleted',
      nodes: plan.nodes,
      deletedNodes: deletion.count,
    };
  }, { isolationLevel: 'Serializable' });
}

async function deleteLeafStory(leafId: string): Promise<DeleteStoryResult> {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await deleteLeafStoryOnce(leafId);
    } catch (error) {
      const shouldRetry =
        isSerializableWriteConflict(error) &&
        attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;
      if (!shouldRetry) throw error;
    }
  }

  throw new Error('Serializable transaction retry loop exhausted unexpectedly');
}

// Get presigned URL for upload
router.post('/upload-url', async (req: Request, res: Response) => {
  try {
    const { filename, contentType } = req.body;

    // The filename becomes part of the S3 key, so it must be a safe basename
    // with an audio extension — never a path or arbitrary string.
    if (!isValidUploadFilename(filename)) {
      return res.status(400).json({ error: 'A valid audio filename is required' });
    }
    if (!isValidUploadContentType(contentType)) {
      return res.status(400).json({ error: 'Unsupported audio content type' });
    }

    const result = await generateUploadUrl(filename, contentType);
    res.json(result);
  } catch (error) {
    console.error('Upload URL generation error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Save audio metadata after successful upload
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { key, durationMs, parentId } = req.body as Partial<SaveAudioPayload>;

    if (!key || durationMs === undefined) {
      return res.status(400).json({ error: 'Key and durationMs required' });
    }

    // Only accept keys this service minted, so a client cannot register an
    // arbitrary or forged S3 object as an audio node.
    if (!isValidAudioKey(key)) {
      return res.status(400).json({ error: 'Invalid audio key' });
    }

    if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
      return res.status(400).json({
        error: 'durationMs must be a positive integer',
      });
    }

    let startTimeMs = 0;
    if (parentId) {
      const parent = await prisma.audioNode.findUnique({
        where: { id: parentId },
        select: {
          id: true,
          parent: {
            select: {
              durationMs: true,
              startTimeMs: true,
            },
          },
        },
      });
      if (!parent) {
        return res.status(404).json({ error: 'Parent audio node not found' });
      }
      startTimeMs = getReplyStartTimeMs(parent.parent);
      if (!Number.isSafeInteger(startTimeMs) || startTimeMs > 2_147_483_647) {
        return res.status(400).json({ error: 'Audio timeline exceeds supported duration' });
      }
    }

    const audioNode = await prisma.audioNode.create({
      data: {
        audioUrl: key,
        durationMs,
        startTimeMs,
        parentId: parentId || null,
      },
    });

    // Return with presigned download URL
    const downloadUrl = await generateDownloadUrl(audioNode.audioUrl);

    res.status(201).json({
      ...audioNode,
      audioUrl: downloadUrl,
    });
  } catch (error) {
    console.error('Save audio error:', error);
    res.status(500).json({ error: 'Failed to save audio' });
  }
});

// List all audio chains (leaf nodes - nodes with no children) with segment data for preview
router.get('/chains', async (req: Request, res: Response) => {
  try {
    interface ChainLeaf {
      id: string;
      createdAt: Date;
    }

    // Find all leaf nodes (nodes that are not a parent of any other node)
    const leafNodes: ChainLeaf[] = await prisma.audioNode.findMany({
      where: {
        children: {
          none: {},
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // For each leaf, get the full chain with segments
    const chains = await Promise.all(
      leafNodes.map(async (leaf) => {
        // Traverse to get all ancestors
        const segments: Array<{
          id: string;
          durationMs: number;
          startTimeMs: number;
          parentId: string | null;
        }> = [];
        let currentId: string | null = leaf.id;

        while (currentId) {
          const node: {
            id: string;
            durationMs: number;
            startTimeMs: number;
            parentId: string | null;
          } | null = await prisma.audioNode.findUnique({
            where: { id: currentId },
            select: {
              id: true,
              durationMs: true,
              startTimeMs: true,
              parentId: true,
            },
          });
          if (!node) break;
          segments.unshift(node); // Add to front to maintain order (oldest first)
          currentId = node.parentId;
        }

        // Calculate total timeline duration
        const totalDurationMs = segments.length > 0
          ? Math.max(...segments.map(segment => segment.startTimeMs + segment.durationMs))
          : 0;

        return {
          id: leaf.id,
          chainLength: segments.length,
          totalDurationMs,
          createdAt: leaf.createdAt,
          segments,
        };
      })
    );

    res.json({ chains });
  } catch (error) {
    console.error('List chains error:', error);
    res.status(500).json({ error: 'Failed to list chains' });
  }
});

// Get audio tree for playback (ancestor chain)
router.get('/tree/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get the node and all its ancestors by traversing parent links
    interface AncestorNode {
      id: string;
      audioUrl: string;
      parentId: string | null;
      durationMs: number;
      startTimeMs: number;
      createdAt: Date;
      updatedAt: Date;
    }

    const ancestors: AncestorNode[] = [];
    let currentId: string | null = id;

    while (currentId) {
      const foundNode: AncestorNode | null = await prisma.audioNode.findUnique({
        where: { id: currentId },
      });

      if (!foundNode) {
        if (ancestors.length === 0) {
          return res.status(404).json({ error: 'Audio node not found' });
        }
        break;
      }

      const downloadUrl = await generateDownloadUrl(foundNode.audioUrl);
      ancestors.unshift({
        ...foundNode,
        audioUrl: downloadUrl,
      });

      currentId = foundNode.parentId;
    }

    res.json({ ancestors });
  } catch (error) {
    console.error('Get tree error:', error);
    res.status(500).json({ error: 'Failed to get audio tree' });
  }
});

// Calibrate latency between two audio nodes (reference and test)
router.post('/calibrate', async (req: Request, res: Response) => {
  try {
    const { referenceNodeId, testNodeId } = req.body as {
      referenceNodeId?: string;
      testNodeId?: string;
    };

    if (!referenceNodeId || !testNodeId) {
      return res.status(400).json({ error: 'referenceNodeId and testNodeId are required' });
    }

    const referenceNode = await prisma.audioNode.findUnique({
      where: { id: referenceNodeId },
      select: { id: true, audioUrl: true, startTimeMs: true },
    });

    const testNode = await prisma.audioNode.findUnique({
      where: { id: testNodeId },
      select: { id: true, audioUrl: true, startTimeMs: true },
    });

    if (!referenceNode || !testNode) {
      return res.status(404).json({ error: 'Reference or test node not found' });
    }

    const localOffsetMs = await measureLatencyMsForKeys(
      referenceNode.audioUrl,
      testNode.audioUrl
    );
    const offsetMs = localOffsetMs
      + testNode.startTimeMs
      - referenceNode.startTimeMs;

    res.json({
      referenceNodeId,
      testNodeId,
      offsetMs,
    });
  } catch (error) {
    console.error('Calibrate latency error:', error);
    res.status(500).json({ error: 'Failed to calibrate latency' });
  }
});

// Delete one leaf story. Shared ancestors are retained for sibling branches.
router.delete('/chain/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await deleteLeafStory(id);
    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Audio story not found' });
    }
    if (result.status === 'not-leaf') {
      return res.status(409).json({ error: 'Only a leaf story can be deleted' });
    }

    const nodeIds = result.nodes.map(node => node.id);

    // Database consistency is authoritative. Object cleanup follows, and an S3
    // failure leaves only an orphaned object rather than a broken story branch.
    for (const node of result.nodes) {
      try {
        await deleteAudioFile(node.audioUrl);
      } catch (s3Error) {
        console.error(`Failed to delete S3 file ${node.audioUrl}:`, s3Error);
        // Continue even if S3 delete fails
      }
    }

    res.json({ 
      success: true, 
      deletedNodes: result.deletedNodes,
      nodeIds,
    });
  } catch (error) {
    console.error('Delete chain error:', error);
    res.status(500).json({ error: 'Failed to delete chain' });
  }
});

export default router;

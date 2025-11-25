import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateUploadUrl, generateDownloadUrl } from '../services/s3Service';

const router = Router();
const prisma = new PrismaClient();

// Get presigned URL for upload
router.post('/upload-url', async (req: Request, res: Response) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename required' });
    }

    const result = await generateUploadUrl(filename);
    res.json(result);
  } catch (error) {
    console.error('Upload URL generation error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Save audio metadata after successful upload
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { key, duration, parentId } = req.body;

    if (!key || duration === undefined) {
      return res.status(400).json({ error: 'Key and duration required' });
    }

    const audioNode = await prisma.audioNode.create({
      data: {
        audioUrl: key,
        duration,
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

// Get audio tree for playback (ancestor chain)
router.get('/tree/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get the node and all its ancestors by traversing parent links
    interface AncestorNode {
      id: string;
      audioUrl: string;
      parentId: string | null;
      duration: number;
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

export default router;

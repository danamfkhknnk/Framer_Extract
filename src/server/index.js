import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import cors from 'cors';
import archiver from 'archiver';
import { deletePrefixFromR2, normalizeUrlRemoveWww, uploadFolderToR2 } from './utils.js';
import { mirrorSite } from './browser-mirror.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json());
// Enable CORS for all routes with specific options
app.use(cors({
  origin: ['http://localhost:3000', 'https://exportnocode.com', '*'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
  credentials: true
}));

// Auth middleware
app.use(async (req, res, next) => {
  const token = req.headers['x-api-key'];
  if (token !== process.env.SECRET_TOKEN) {
    return res.status(401).json({ detail: "Unauthorized" });
  }
  next();
});

// ================================
// Health check - support both paths
// ================================
app.get(['/api/health', '/health'], (req, res) => {
  res.json({
    status: "healthy",
    service: "Website Mirror API",
    version: "1.0.0"
  });
});

// ================================
// Mirror a website - support both API paths
// ================================
// Leave headroom under the frontend's ~380s fetch timeout (url-input.tsx)
const MIRROR_TIMEOUT_MS = 360000;

app.post(['/api/mirror', '/mirror'], async (req, res) => {
  try {
    const { url, max_depth = 2, wait_time = 2.0 } = req.body;

    if (!url) return res.status(400).json({ detail: "URL is required" });
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ detail: "Invalid URL format. Must start with http:// or https://" });
    }

    let normalizedUrl;
    let hostname;
    try {
      normalizedUrl = normalizeUrlRemoveWww(url);
      hostname = new URL(normalizedUrl).hostname;
    } catch {
      return res.status(400).json({ detail: "Invalid URL" });
    }

    const mirrorsDir = path.join(process.cwd(), 'mirrors');

    // Create mirrors directory if it doesn't exist
    if (!fs.existsSync(mirrorsDir)) {
      fs.mkdirSync(mirrorsDir, { recursive: true });
    }

    const outputDir = path.join(mirrorsDir, hostname);

    // If local directory exists from a previous run, remove it to replace with fresh mirror
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`Running browser mirror for: ${normalizedUrl}`);

    let responded = false;
    const sendOnce = (status, body) => {
      if (responded) return;
      responded = true;
      res.status(status).json(body);
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      console.error(`mirror timed out after ${MIRROR_TIMEOUT_MS}ms for ${normalizedUrl}`);
      sendOnce(504, { detail: 'Mirror operation timed out. The site may be too large or slow; try a smaller max_depth.' });
    }, MIRROR_TIMEOUT_MS);

    try {
      const result = await mirrorSite(normalizedUrl, outputDir, {
        maxDepth: max_depth,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (responded) return; // timeout already fired while we were finishing up

      console.log(`Mirror done: ${result.resourcesCaptured} resources, ${result.documentsRewritten} pages`);

      const hasFiles = fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0;
      if (!hasFiles) {
        return sendOnce(500, { detail: 'Mirror operation failed: no content was captured.' });
      }

      // Create a zip file of the mirrored content
      const timestamp = Date.now();
      const zipFileName = `${hostname}-${timestamp}.zip`;
      const zipFilePath = path.join(mirrorsDir, zipFileName);

      try {
        // Create zip file
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        // Listen for errors
        archive.on('error', (err) => {
          throw err;
        });

        // Pipe archive data to the output file
        archive.pipe(output);

        // Add files from the directory to the archive
        archive.directory(outputDir, false);

        // Finalize the archive
        await archive.finalize();

        // Wait for the output stream to finish
        await new Promise((resolve) => {
          output.on('close', resolve);
        });

        console.log(`Zip archive created: ${zipFilePath}`);

        // Try to upload to R2, but don't block the download if it fails
        try {
          // Remove any existing objects for this hostname in R2, then upload fresh copy
          console.log("Attempting to upload to R2 storage...");
          await deletePrefixFromR2(hostname);
          // Upload to R2
          await uploadFolderToR2(outputDir, hostname);
          console.log("R2 upload completed successfully");
        } catch (r2Error) {
          // Log the error but continue with the download
          console.error("R2 storage error (download will still work):", r2Error);
        }

        if (responded) {
          // Client already gave up (e.g. its own timeout fired); just clean up.
          fs.unlinkSync(zipFilePath);
          return;
        }
        responded = true;

        // Send the zip file directly as a download
        res.download(zipFilePath, zipFileName, (err) => {
          if (err) {
            console.error(`Error sending zip file: ${err}`);
          }

          // Clean up zip file after download completes or fails
          setTimeout(() => {
            if (fs.existsSync(zipFilePath)) {
              fs.unlinkSync(zipFilePath);
              console.log(`Deleted zip file: ${zipFilePath}`);
            }
          }, 60000); // Delete after 1 minute
        });
      } catch (error) {
        console.error(`Error creating zip file: ${error}`);
        // Clean up if zip creation fails
        if (fs.existsSync(zipFilePath)) {
          fs.unlinkSync(zipFilePath);
        }

        sendOnce(500, {
          status: "error",
          message: `Failed to create zip file: ${error.message}`,
          url: normalizedUrl
        });
      }
    } catch (error) {
      clearTimeout(timeout);
      console.error('Mirror operation failed:', error);
      sendOnce(500, { detail: `Mirror operation failed: ${error.message}` });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ detail: `Mirror operation failed: ${error.message}` });
  }
});

// Start the server if not being imported
if (import.meta.url === `file://${process.argv[1]}`) {
  // Always use port 3001 for development to match Next.js API route expectations
  const PORT = 3001;
  try {
    app.listen(PORT, () => {
      console.log(`Express server running on port ${PORT}`);
      console.log(`Test the API by visiting: http://localhost:${PORT}/api/health`);
      console.log(`SECRET_TOKEN set: ${process.env.SECRET_TOKEN ? 'Yes' : 'No'}`);
      console.log(`R2 config available: ${process.env.R2_ENDPOINT ? 'Yes' : 'No'}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Export the Express app as default export for Vercel
export default app;

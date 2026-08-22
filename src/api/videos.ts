import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import os from "os";
import path from "path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Invalid video file type");
  }
  
  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file too large");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  
  if (userID !== video.userID) {
    throw new UserForbiddenError("Authenticated user is not the video owner");
  }

  let processedTempPath: string | undefined;
  let key: string | undefined;

  const fileName = `${videoId}.${mediaType.split("/")[1]}`;
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, fileName);
  
  try{
    
    await Bun.write(tempFilePath, await file.arrayBuffer());
    processedTempPath = await processVideoForFastStart(tempFilePath);
    const aspectRatioString = await getVideoAspectRatio(processedTempPath);
    key = `${aspectRatioString}/${fileName}`;
    const tempFile = Bun.file(processedTempPath);
    const s3file = cfg.s3Client.file(key);
      
    await s3file.write(tempFile, { type: mediaType });
  } finally {
    await Bun.file(tempFilePath).delete();
    if (processedTempPath) {
      await Bun.file(processedTempPath).delete();
    }
  }

  if (!key) {
    throw new Error("Video upload did not produce an S3 key");
  }

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);
  
  return respondWithJSON(200, video);
}

export async function getVideoAspectRatio(filepath: string): Promise< string > {
  const aspectRatio = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filepath]);
  const stdoutText = await new Response(aspectRatio.stdout).text();
  const stderrText = await new Response(aspectRatio.stderr).text();
  const exited = await aspectRatio.exited;
  let aspectRatioString: string;
  if (exited == 0) {
    const json = JSON.parse(stdoutText);
    const width = json.streams[0].width;
    const height = json.streams[0].height;

    if (Math.floor((width / height) * 10) == Math.floor((16 / 9) * 10)) {
      aspectRatioString = "landscape";
    } else if (Math.floor((width / height) * 10) == Math.floor((9 / 16) * 10)) {
      aspectRatioString = "portrait";
    } else {
      aspectRatioString = "other";
    }
    
    return aspectRatioString;
  } else {
    console.error(`ffprobe error: ${stderrText}`);
    throw new Error(`ffprobe failed with exit code ${exited}`);
  }
}

export async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = inputFilePath.replace(/\.mp4$/, ".processed.mp4");
  const ffmpegProcess = Bun.spawn([
    "ffmpeg",
    "-i", inputFilePath,
    "-movflags", "faststart",
    "-map_metadata", "0",
    "-codec", "copy",
    "-f", "mp4",
    outputFilePath
  ], { stderr: "pipe" });
  const exited = await ffmpegProcess.exited;
  if (exited !== 0) {
    const stderrText = await new Response(ffmpegProcess.stderr).text();
    console.error(`ffmpeg error: ${stderrText}`);
    throw new Error(`ffmpeg failed with exit code ${exited}`);
  }
  return outputFilePath;
}
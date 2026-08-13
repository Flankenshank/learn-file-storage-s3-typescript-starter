import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path/win32";

type Thumbnail = {
  dataUrl: string;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  
  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // 10 MB
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file too large");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (userID !== video.userID) {
    throw new UserForbiddenError("Authenticated user is not the video owner");
  }

  const mediaType = file.type;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Invalid thumbnail file type");
  }
  const fileName = `${videoId}.${mediaType.split("/")[1]}`;
  const mediaFilePath = path.posix.join(cfg.assetsRoot, fileName);
  await Bun.write(mediaFilePath, await file.arrayBuffer());
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`;
  updateVideo(cfg.db, video);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  return respondWithJSON(200, video);
}

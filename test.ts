import { getVideoAspectRatio } from "./src/api/videos"; // adjust path/export as needed

const result = await getVideoAspectRatio("/home/flank/workspace/filestorage/samples/boots-video-vertical.mp4");
console.log(result);
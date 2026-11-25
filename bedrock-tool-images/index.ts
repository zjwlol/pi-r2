import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moveImagesOutOfToolResults } from "../shared/bedrock-tool-images.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => moveImagesOutOfToolResults(event.payload));
}

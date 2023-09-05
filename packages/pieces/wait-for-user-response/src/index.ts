
import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { WaitForAction } from "./lib/wait-for-action";

export const waitForUserResponse = createPiece({
  displayName: "Wait For Response",
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.8.0',
  logoUrl: "https://cdn.activepieces.com/pieces/delay.png",
  authors: ["rawatravi"],
  actions: [WaitForAction],
  triggers: [],
});

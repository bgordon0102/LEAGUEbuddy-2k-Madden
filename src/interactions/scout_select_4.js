import { handleScoutSelect } from "../commands/2k/coach/scout.js";

export const customId = "scout_select_4";
export async function execute(interaction) {
    await handleScoutSelect(interaction, 4);
}

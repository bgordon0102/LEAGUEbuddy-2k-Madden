import { handleScoutSelect } from "../commands/coach/scout.js";

export const customId = "scout_select_3";
export async function execute(interaction) {
    await handleScoutSelect(interaction, 3);
}

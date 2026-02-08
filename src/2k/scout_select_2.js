import { handleScoutSelect } from "../2k/coach/scout.js";

export const customId = "scout_select_2";
export async function execute(interaction) {
    await handleScoutSelect(interaction, 2);
}

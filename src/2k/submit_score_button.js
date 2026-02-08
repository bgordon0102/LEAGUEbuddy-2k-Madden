// Handler for submit_score_* buttons (coach box score upload)
export const customId = /^submit_score_/;
export async function execute(interaction) {
    // Import the main handler from submit_score.js
    const { handleSubmitScore } = await import('./submit_score.js');
    await handleSubmitScore(interaction);
}

// /grill <topic>: turn one chat message into a normal agent turn that interviews the user about a plan or design.
// The agent asks one question per turn with ask_user_question, reads the codebase to answer what it can, and writes
// the resolved plan to /.luna/plans. It implements nothing. Keep the instruction free of the words the session-learning
// RULE detector reads as user rules (see learn-command.ts and learn.ts).

export const GRILL_USAGE = "Usage: /grill <plan, design, or topic>";

/** Parse the text after `/grill`. Empty input is not a request. */
export function parseGrill(args: string): string | null {
  return args.trim() || null;
}

/** The user turn the agent receives. The first line keeps the original command visible in the transcript. */
export function grillPrompt(topic: string): string {
  return [
    `/grill ${topic}`,
    "",
    "Interview me about the plan or design below until every branch of its decision tree is resolved.",
    `Topic: ${topic}`,
    "",
    "Method:",
    "1. List the decisions the topic depends on. Walk them in dependency order: settle a decision before the ones that rest on it.",
    "2. If reading the codebase, docs, or files can answer a question, read them and state what you found. Ask me only what the sources cannot settle.",
    "3. Ask one question per turn with the ask_user_question tool. Give 2 to 4 concrete options. Put your recommended option first and mark its label \"(Recommended)\". Base the recommendation on what you read, and say why.",
    "4. Challenge weak answers. Point out contradictions, risks, and unstated assumptions, then ask again if needed.",
    "5. This is planning only. Do not change files, run builds, or implement anything, except the plan file in step 6.",
    "6. Stop when no open decision remains or I say stop. Then write the resolved plan to /.luna/plans/<yyyy-mm-dd>-<slug>.md. Include the goal, each decision with its reason, open risks, and ordered steps with how to verify each one. Report the file path.",
  ].join("\n");
}

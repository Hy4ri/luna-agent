// /skillcraft <idea or skill name>: turn one chat message into an interview-driven agent turn that crafts a skill.
// The agent asks one question per turn with ask_user_question, shows the full draft, and writes only after approval,
// through the skill tool (lint, backup, rollback). Typing /skillcraft authorizes creating or
// updating ONE managed skill after that in-flow approval. External skills stay read-only.
// Keep the instruction free of the words the session-learning RULE detector reads as user rules (see learn.ts).

export const SKILLCRAFT_USAGE = "Usage: /skillcraft <skill idea or existing skill name>";

/** Parse the text after `/skillcraft`. Empty input is invalid. */
export function parseSkillcraft(args: string): string | null {
  const t = args.trim();
  return t || null;
}

/** The user turn the agent receives. The first line keeps the original command visible in the transcript. */
export function skillcraftPrompt(topic: string): string {
  return [
    `/skillcraft ${topic}`,
    "",
    "Interview me until you can write one skill, then save it after I approve the draft.",
    `Topic: ${topic}`,
    "",
    "Steps:",
    "1. Run skill action=list first. If a managed skill already covers the topic, view it and plan an update instead of a new skill. External skills are read-only: create a new managed skill instead of editing one.",
    "2. Interview me relentlessly with ask_user_question. Ask ONE question per turn, with 2 to 4 concrete options. Put the recommended option first and add \"(Recommended)\" to its label.",
    "3. Resolve these points in order: (a) the trigger, meaning when to use the skill, which becomes the frontmatter description; (b) scope and non-goals; (c) the exact procedure steps; (d) gates and verification; (e) pitfalls; (f) the tools it needs; (g) linked reference files.",
    "4. If the codebase, this session, or an existing skill can answer a question, read it instead of asking me. Challenge vague or contradictory answers.",
    "5. Stop when nothing is open or when I say stop. Show the full draft SKILL.md, including the frontmatter name and description. Then ask for approval with ask_user_question (purpose approval).",
    "6. Only after I approve, save it with skill action=create or edit. Fix lint errors and retry. Do not write outside the skills store. Typing /skillcraft authorizes this one skill write after that approval.",
    "7. Report the skill name, whether it was created or updated, and its path. If I decline, do not write anything.",
  ].join("\n");
}

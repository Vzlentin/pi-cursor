/** Cursor's question UI is not connected to Pi's chat or user input. */
export const PI_QUESTION_POLICY =
  "You are running in Pi. Cursor's AskUserQuestion/AskQuestion UI is unavailable; do not call it. " +
  "If clarification or approval is necessary, ask in ordinary assistant chat and wait for the " +
  "user's reply. Otherwise continue within the user's existing instructions and authorization. " +
  "An unavailable question UI does not mean the user skipped, rejected, or approved anything.";

export const PI_QUESTION_UNAVAILABLE =
  "Provider capability error: this question was not shown to the user. No user response was " +
  "collected; the user did not skip or reject the question. Do not retry this tool. " +
  PI_QUESTION_POLICY;

// The lists a new account starts with: each task shows (or asks you to try) one thing todone does.
import { addDays } from "@todone/sdk/calendar";
import { type Task, parse } from "@todone/sdk/tasks";

export function demoLists(today: string): { name: string; tasks: Task[]; kind?: "ideas" }[] {
  const tomorrow = addDays(today, 1);
  return [
    {
      name: "Welcome to todone",
      tasks: parse(
        [
          `- [ ] Tick me off and earn XP`,
          `- [ ] Plan the week ⏫ ⏱ 30m 💪 m 📅 ${today} ⏰ 16:00`,
          `  - [ ] Look at the calendar`,
          `  - [ ] Pick three things that matter`,
          `- [ ] Drag me onto the Tomorrow sticker`,
          `- [ ] Drop me on another note to make me a step`,
          `- [ ] Water the plants 🔁 every week 📅 ${tomorrow}`,
          `- [ ] Read 20 pages 🔽 ⏱ 30m`,
          `- [ ] Set a goal in Goals, like reading 5 days a week`,
          `- [ ] Pick a reward to spend your XP on`,
          `- [ ] Turn on reminders from the bell`,
        ].join("\n"),
      ),
    },
    { name: "Groceries", tasks: parse("- [ ] Oat milk\n- [ ] Coffee beans\n- [ ] Bananas\n") },
    {
      name: "Brainstorm",
      kind: "ideas",
      tasks: parse("- [ ] Learn to make fresh pasta\n- [ ] A weekend trip somewhere new\n- [ ] Start a reading list\n"),
    },
  ];
}

import a from './group-a-page-questions.js';
import b from './group-b-tabs.js';
import c from './group-c-youtube.js';
import d from './group-d-agent.js';
import e from './group-e-connected-apps.js';
import f from './group-f-safety.js';
import g from './group-g-operational.js';

// Sorted by id so a scoreboard reads in task order rather than file order.
export const TASKS = [...a, ...b, ...c, ...d, ...e, ...f, ...g].sort((x, y) =>
  Number(x.id.slice(1)) - Number(y.id.slice(1))
);
export default TASKS;

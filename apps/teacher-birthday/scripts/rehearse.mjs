// npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 all
import { execFileSync } from "node:child_process";
const [teacher, step = "all"] = process.argv.slice(2);
if (!teacher || !["ask", "celebrate", "all"].includes(step)) {
  console.error("用法：npm run rehearse -- <老师姓名> [ask|celebrate|all]");
  process.exit(1);
}
execFileSync("tcb", ["fn", "invoke", "birthday-api", "-e", "jingshi-test-d5gp401i44a0fa7a7", "--params", JSON.stringify({ action: "rehearse", teacher, step })], { stdio: "inherit" });

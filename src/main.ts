// Entry point. See docs/PLAN.md.
import { startApp } from "./ui/app";

const root = document.getElementById("app");
if (root !== null) startApp({ root });

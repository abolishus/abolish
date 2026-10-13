import { createFileRoute } from "@tanstack/react-router";

import { HowItWorks } from "../components/how-it-works.tsx";

export const Route = createFileRoute("/how-it-works")({ component: HowItWorks });

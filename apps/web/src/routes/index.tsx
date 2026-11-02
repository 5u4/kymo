import { createFileRoute } from "@tanstack/react-router";

const Home = () => <h1 className="p-6 text-2xl font-semibold">kymo</h1>;

export const Route = createFileRoute("/")({ component: Home });

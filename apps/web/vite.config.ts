import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: { proxy: { "/api": server, "/mcp": server } },
});

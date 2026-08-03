import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/teacher_connect/",
  server: {
    port: 5190,
    strictPort: true,
  },
});

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ExitCraft Studio — Floor plan to 3D",
  description: "Turn a floorplan into a 3D building. Orbit, inspect, and walk through your space in ExitCraft Studio.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

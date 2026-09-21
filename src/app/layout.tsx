import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Taskcal",
  description: "飲食店の突発欠勤に対する代替スタッフ調整（ハッカソンMVP・開発中）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

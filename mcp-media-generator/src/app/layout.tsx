import type { Metadata } from "next";
import "./globals.css";

/**
 * الواجهة العربية RTL — خط عربي جيد مع بدائل نظام آمنة (بلا تحميل خطوط وقت البناء)
 */
export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body
        className="antialiased bg-slate-950 text-slate-100"
        style={{ fontFamily: '"Cairo", "Tajawal", "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif' }}
      >
        {children}
      </body>
    </html>
  );
}

import Link from "next/link";

const columns = [
  {
    title: "产品",
    items: [
      ["AI 研究", "/newstudy"],
      ["AI Persona", "/persona"],
      ["AI 访谈", "/interview"],
      ["AI Sage", "/sage"],
    ],
  },
  {
    title: "解决方案",
    items: [
      ["企业版", "/enterprise"],
      ["营销人员", "/marketers"],
      ["产品经理", "/product-managers"],
      ["创业者", "/startup-owners"],
    ],
  },
  {
    title: "资源",
    items: [
      ["技术", "/technology"],
      ["价格", "/pricing"],
      ["常见问题", "/faq"],
      ["API 文档", "/docs/api"],
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container footer-grid">
        <div>
          <div className="brand">atypica.AI</div>
          <p>为「主观世界」建模</p>
          <p className="footer-copyright">© 2026 BMRLab. 保留所有权利。</p>
        </div>
        {columns.map((column) => (
          <div className="footer-column" key={column.title}>
            <h2>{column.title}</h2>
            {column.items.map(([label, href]) => (
              <Link href={href} key={href}>
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </footer>
  );
}

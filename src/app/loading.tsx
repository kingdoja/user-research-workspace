import { LoaderCircle } from "lucide-react";
import styles from "./loading.module.css";

export default function Loading() {
  return (
    <div className={styles.shell} role="status" aria-label="页面加载中">
      <LoaderCircle className={styles.spinner} aria-hidden="true" />
    </div>
  );
}

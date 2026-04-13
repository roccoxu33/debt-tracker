import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// 从环境变量读取（Vercel 上配置，或本地 .env 文件）
const firebaseConfig = {
  apiKey:             import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:         import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:          import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:      import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId:  import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:              import.meta.env.VITE_FIREBASE_APP_ID,
};

// 检查是否已配置 Firebase
export const firebaseConfigured =
  !!firebaseConfig.apiKey && firebaseConfig.apiKey !== "undefined";

let db = null;

if (firebaseConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
}

export { db };

/* 초기 샘플 데이터: localStorage가 비어있을 때만 사용 */
window.seedEntries = [
  {
    id: "note-0001",
    title: "첫 노트: 테스트",
    book: "예시 책",
    page: "p.12",
    content:
      `# 샘플

- 여기는 마크다운으로 쓰는 공간
- 프리뷰는 없지만, 나중에 글로 재가공할 때 유리함


내부 링크: [[note-0002]] 또는 [[두 번째 노트]]`,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    history: []
  },
  {
    id: "note-0002",
    title: "두 번째 노트",
    book: "미디어의 이해",
    page: "챕터: 수",
    content:
      `## 메모

발췌/단상을 모아두고 나중에 다시 쓰기.`,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 1,
    history: []
  }
];

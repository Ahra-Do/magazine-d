# Magazine D — ISSUE NO.1 프로토타입

매거진 B 이슈 페이지(https://magazine-b.com/product/detail.html?product_no=367&cate_no=44)의 블록 순서를 그대로 옮긴 모바일 웹진 뼈대.

## 파일
- `index.html` — 창간호 본문 (12개 블록)
- `survey.html` — 결혼 소식 + 독자 설문 페이지 (Tally/Google Form 임베드 자리)

## 블록 순서 (B 원본 → 창간호)
1. 상단 바 → D / Issues / Survey / KR·EN
2. 헤더 3단 → Magazine D / ISSUE NO.1 / DO AH RA & JO DONG IN
3. 스펙 표 → language / format / pages / date / circulation
4. Description → 두 사람 요약 1문단
5. 히어로 → 스튜디오 대표컷
6. 스프레드 01~03 → 아라 어릴 때
7. 인용구 1 → 신부 부모님
8. 스프레드 04~06 → 동인 어릴 때
9. 인용구 2 → 신랑 부모님
   (추가) 07~09 만남 / 인용구 3 친구 / 10~12 스튜디오 / 인용구 4 두 사람 / 13~15 가족식
10. Related 3칸 → ISSUE NO.2 BOSTON / Reader Survey / Letters
11. 푸터

## 사진 넣는 법
회색 박스 `<div class="spread"><div class="ph">…</div></div>` 를
`<div class="spread"><img src="photos/01.jpg" alt=""></div>` 로 바꾸면 됩니다.
좌우 2장짜리(`spread duo`)는 안쪽 `<div>` 각각에 `<img>`.
비율은 4:3 고정(B 원본 1920×1440). 세로 사진은 duo 칸에 넣는 것이 자연스럽습니다.

## 인용구 넣는 법
`<blockquote class="quote"><p>말</p><span class="by">이름, 관계</span></blockquote>`
말투는 고치지 않습니다. 사진 3장당 인용구 1개가 B의 리듬입니다.

## 배포
정적 HTML이라 GitHub Pages, Netlify Drop, Vercel 어디든 폴더째 올리면 끝.

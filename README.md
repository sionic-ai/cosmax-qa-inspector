# COSMAX Cosmetic QA Inspector

고객사 코스맥스의 화장품 라인 불량 검사 데모입니다.
초당 N장의 이미지를 [OpenGateway](https://opengateway.ai/)의 `moonshotai/kimi-k3-ultrafast` 비전 모델로 전송하여 불량 여부를 실시간 판정합니다.

## 실행

```bash
# API 키 설정
export OPENGATEWAY_API_KEY="apik_xxx"

# 서버 실행
npm start
```

브라우저에서 `http://localhost:5173` 접속.

## 기능

- 초당 1~8장 이미지 검사 (슬라이더 조절)
- 실시간 TPS 측정 및 추이 그래프
- 정상/불량 판정 결과를 카드 피드로 표시
- 최신 결과 Spotlight 표시
- 누적 통계 (총 검사 수, 정상/불량 수, 불량률)
- 데모 이미지 모드 / 실제 이미지 업로드 지원

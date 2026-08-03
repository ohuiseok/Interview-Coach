import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Download,
  Home,
  KeyRound,
  Mic,
  RotateCcw,
  Sparkles,
  Timer,
  Upload,
} from 'lucide-react'
import './App.css'
import templateCsv from './assets/interview-template.csv?raw'

const WAIT_SECONDS = 3
const ANSWER_SECONDS = 30
const OPENAI_MODEL = 'gpt-4.1-mini'

function normalizeApiKey(value) {
  return value
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

function downloadTemplate() {
  const blob = new Blob([`\uFEFF${templateCsv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'interview-template.csv'
  link.click()
  URL.revokeObjectURL(url)
}

async function readCsvFile(file) {
  const buffer = await file.arrayBuffer()

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('euc-kr', { fatal: true }).decode(buffer)
    } catch {
      return new TextDecoder('utf-8').decode(buffer)
    }
  }
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      cell += '"'
      i += 1
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim())
      cell = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)

  const withoutBom = rows.map(([first, ...rest]) => [
    first?.replace(/^\uFEFF/, ''),
    ...rest,
  ])
  const hasHeader = withoutBom[0]?.[0] === '질문' && withoutBom[0]?.[1] === '예상답변'
  const dataRows = hasHeader ? withoutBom.slice(1) : withoutBom

  return dataRows
    .map(([question, expectedAnswer]) => ({
      question: question?.trim(),
      expectedAnswer: expectedAnswer?.trim(),
    }))
    .filter((item) => item.question && item.expectedAnswer)
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition
}

function shuffleItems(items) {
  const shuffled = [...items]

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  return shuffled
}

function hasLiveMediaTracks(stream) {
  const hasLiveAudio = stream
    ?.getAudioTracks()
    .some((track) => track.readyState === 'live')
  const hasLiveVideo = stream
    ?.getVideoTracks()
    .some((track) => track.readyState === 'live')

  return Boolean(hasLiveAudio && hasLiveVideo)
}

function buildFeedbackPrompt({ question, expectedAnswer, transcript }) {
  return [
    '너는 10년 차 시니어 개발자 면접관이다.',
    '지원자의 답변을 실제 기술 면접 기준으로 평가한다.',
    '친절한 튜터처럼 길게 설명하지 말고, 면접관이 면접 후 남기는 평가 메모처럼 구체적이고 간결하게 피드백해라.',
    '질문 의도, 핵심 키워드 포함 여부, 논리 구조, 실무 이해도, 보완 답변 예시를 기준으로 평가한다.',
    '지원자의 답변이 비어 있거나 부족하면, 부족하다고 명확히 말하고 어떤 방향으로 답해야 하는지 제시한다.',
    '반드시 한국어로 답변하고, 아래 형식을 정확히 지켜라.',
    '',
    '1. 면접관 평가: 한 문장',
    '2. 질문 의도: 이 질문으로 확인하려는 역량',
    '3. 잘한 점: 최대 2개',
    '4. 부족한 점: 최대 2개',
    '5. 더 나은 답변 예시: 5문장 이내',
    '6. 다음 답변에 넣을 키워드: 3~5개',
    '',
    `면접 질문: ${question}`,
    `템플릿 예상 답변: ${expectedAnswer}`,
    `지원자 답변: ${transcript || '답변 없음'}`,
  ].join('\n')
}

function App() {
  const [page, setPage] = useState('setup')
  const [template, setTemplate] = useState([])
  const [permissionStatus, setPermissionStatus] = useState('권한 확인 전')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [currentItem, setCurrentItem] = useState(null)
  const [questionQueue, setQuestionQueue] = useState([])
  const [phase, setPhase] = useState('idle')
  const [countdown, setCountdown] = useState(WAIT_SECONDS)
  const [answerTime, setAnswerTime] = useState(ANSWER_SECONDS)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [retakeUsed, setRetakeUsed] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackStatus, setFeedbackStatus] = useState('idle')
  const [cameraStream, setCameraStream] = useState(null)
  const fileInputRef = useRef(null)
  const videoRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const recognitionRef = useRef(null)
  const answeringActiveRef = useRef(false)
  const finalTranscriptRef = useRef('')
  const interimTranscriptRef = useRef('')
  const feedbackAbortRef = useRef(null)
  const feedbackRequestIdRef = useRef(0)

  const speechSupported = useMemo(() => Boolean(getSpeechRecognition()), [])
  const mediaReady = hasLiveMediaTracks(cameraStream)
  const canRequestFeedback = Boolean(apiKey.trim()) && phase === 'result'

  useEffect(() => {
    cameraStreamRef.current = cameraStream

    if (!videoRef.current || !cameraStream) return

    videoRef.current.srcObject = cameraStream
    videoRef.current.play?.().catch(() => {
      setError('카메라 미리보기를 자동 재생하지 못했어요. 브라우저 권한을 확인해주세요.')
    })
  }, [cameraStream, page])

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort?.()
      feedbackAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (phase !== 'waiting') return undefined

    if (countdown <= 0) {
      startAnswering()
      return undefined
    }

    const timer = window.setTimeout(() => {
      setCountdown((current) => current - 1)
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [countdown, phase])

  useEffect(() => {
    if (phase !== 'answering') return undefined

    if (answerTime <= 0) {
      finishAnswer()
      return undefined
    }

    const timer = window.setTimeout(() => {
      setAnswerTime((current) => current - 1)
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [answerTime, phase])

  function handleApiKeyChange(event) {
    setApiKey(event.target.value)
  }

  async function requestPermissions() {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      })
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current = stream
      setCameraStream(stream)
      setPermissionStatus('카메라와 마이크 준비 완료')
      return stream
    } catch {
      setPermissionStatus('권한 필요')
      setError('카메라와 마이크 권한을 허용해야 면접 연습을 시작할 수 있어요.')
      return null
    }
  }

  async function handleUpload(event) {
    setError('')
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const stream = hasLiveMediaTracks(cameraStream) ? cameraStream : await requestPermissions()
      if (!stream) return

      const text = await readCsvFile(file)
      const parsed = parseCsv(text)

      if (parsed.length === 0) {
        setError('CSV에서 질문과 예상답변 쌍을 찾지 못했어요.')
        return
      }

      const shuffledQuestions = shuffleItems(parsed)
      const [firstItem, ...remainingQuestions] = shuffledQuestions
      setTemplate(parsed)
      setCurrentItem(firstItem)
      setQuestionQueue(remainingQuestions)
      setRetakeUsed(false)
      setTranscript('')
      setFeedback('')
      setFeedbackStatus('idle')
      finalTranscriptRef.current = ''
      interimTranscriptRef.current = ''
      setPage('practice')
      beginWaiting(firstItem)
    } catch {
      setError('CSV 파일을 읽는 중 문제가 생겼어요. 템플릿 형식을 확인해주세요.')
    } finally {
      event.target.value = ''
    }
  }

  async function handleUploadClick() {
    setError('')
    const stream = mediaReady ? cameraStream : await requestPermissions()

    if (!stream) return

    fileInputRef.current?.click()
  }

  function beginWaiting(nextItem = currentItem) {
    if (!nextItem) return
    answeringActiveRef.current = false
    recognitionRef.current?.abort?.()
    feedbackAbortRef.current?.abort()
    feedbackRequestIdRef.current += 1
    setCurrentItem(nextItem)
    setCountdown(WAIT_SECONDS)
    setAnswerTime(ANSWER_SECONDS)
    setTranscript('')
    setInterimTranscript('')
    setFeedback('')
    setFeedbackStatus('idle')
    finalTranscriptRef.current = ''
    interimTranscriptRef.current = ''
    setPhase('waiting')
  }

  function startAnswering() {
    setPhase('answering')
    setAnswerTime(ANSWER_SECONDS)

    const SpeechRecognition = getSpeechRecognition()
    if (!SpeechRecognition) return

    const recognition = new SpeechRecognition()
    recognition.lang = 'ko-KR'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      let interim = ''
      let finalText = finalTranscriptRef.current

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        if (result.isFinal) {
          finalText = `${finalText} ${result[0].transcript}`.trim()
        } else {
          interim += result[0].transcript
        }
      }

      finalTranscriptRef.current = finalText
      interimTranscriptRef.current = interim
      setTranscript(finalText)
      setInterimTranscript(interim)
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        return
      }

      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
        answeringActiveRef.current = false
      }

      setError(
        event.error === 'network'
          ? '음성 인식 네트워크가 불안정해요. 계속 말해보고, 결과 화면에서 직접 수정할 수 있어요.'
          : '음성 인식이 일시적으로 중단됐어요. 결과 화면에서 직접 수정할 수 있어요.',
      )
    }

    recognition.onend = () => {
      if (answeringActiveRef.current) {
        try {
          recognition.start()
        } catch {
          answeringActiveRef.current = false
        }
      }
    }

    recognitionRef.current = recognition
    answeringActiveRef.current = true
    try {
      recognition.start()
    } catch {
      answeringActiveRef.current = false
      setError('음성 인식을 시작하지 못했어요. 결과 화면에서 직접 입력할 수 있어요.')
    }
  }

  function finishAnswer() {
    answeringActiveRef.current = false
    recognitionRef.current?.stop?.()
    const finishedTranscript = [
      finalTranscriptRef.current,
      interimTranscriptRef.current,
    ]
      .filter(Boolean)
      .join(' ')
      .trim()

    finalTranscriptRef.current = finishedTranscript
    interimTranscriptRef.current = ''
    setInterimTranscript('')
    setTranscript(finishedTranscript)
    setPhase('result')
  }

  function handleRetake() {
    if (retakeUsed || !currentItem) return
    setRetakeUsed(true)
    setError('')
    beginWaiting(currentItem)
  }

  function handleNextQuestion() {
    const nextQueue =
      questionQueue.length > 0
        ? questionQueue
        : shuffleItems(template).filter((item) => item !== currentItem)
    const [nextItem, ...remainingQuestions] = nextQueue

    if (!nextItem) return

    setQuestionQueue(remainingQuestions)
    setError('')
    setRetakeUsed(false)
    beginWaiting(nextItem)
  }

  async function requestAiFeedback() {
    const normalizedApiKey = normalizeApiKey(apiKey)
    if (!currentItem || !normalizedApiKey) return

    setError('')
    setFeedback('')
    setFeedbackStatus('loading')
    feedbackAbortRef.current?.abort()
    const requestId = feedbackRequestIdRef.current + 1
    feedbackRequestIdRef.current = requestId
    const controller = new AbortController()
    feedbackAbortRef.current = controller

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${normalizedApiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'user',
              content: buildFeedbackPrompt({
                question: currentItem.question,
                expectedAnswer: currentItem.expectedAnswer,
                transcript,
              }),
            },
          ],
        }),
      })

      const data = await response.json()

      if (requestId !== feedbackRequestIdRef.current) return

      if (!response.ok) {
        throw new Error(data.error?.message || 'AI 피드백 요청에 실패했어요.')
      }

      const outputText =
        data.choices?.[0]?.message?.content ||
        data.output_text ||
        data.output
          ?.flatMap((item) => item.content ?? [])
          .map((content) => content.text)
          .filter(Boolean)
          .join('\n')

      setFeedback(outputText || '피드백 내용을 읽지 못했어요.')
      setFeedbackStatus('done')
    } catch (feedbackError) {
      if (feedbackError.name === 'AbortError') return
      if (requestId !== feedbackRequestIdRef.current) return
      setFeedbackStatus('idle')
      setError(feedbackError.message || 'AI 피드백을 가져오지 못했어요.')
    } finally {
      if (requestId === feedbackRequestIdRef.current) {
        feedbackAbortRef.current = null
      }
    }
  }

  function resetApp() {
    recognitionRef.current?.abort?.()
    feedbackAbortRef.current?.abort()
    feedbackRequestIdRef.current += 1
    answeringActiveRef.current = false
    setPage('setup')
    setTemplate([])
    setCurrentItem(null)
    setQuestionQueue([])
    setPhase('idle')
    setTranscript('')
    setInterimTranscript('')
    setRetakeUsed(false)
    setFeedback('')
    setFeedbackStatus('idle')
    setError('')
  }

  const shownTranscript = [transcript, interimTranscript].filter(Boolean).join(' ')

  if (page === 'setup') {
    return (
      <main className="appShell setupPage">
        <section className="onboardingCard" aria-label="면접 연습 시작">
          <div className="workspaceHeader">
            <div className="brandMark">
              <span>IP</span>
              <p>Interview Practice</p>
            </div>
            <p className="eyebrow">
              <Sparkles size={16} />
              AI Interview Studio
            </p>
            <h1>면접 연습을 시작하세요</h1>
            <div className="quickMeta" aria-label="면접 연습 구성">
              <span>
                <Timer size={15} />
                30초
              </span>
              <span>
                <Mic size={15} />
                녹음
              </span>
              <span>
                <Sparkles size={15} />
                피드백
              </span>
            </div>
          </div>

          <div className="permissionRow">
            <div>
              <span className="rowIcon">
                <Camera size={17} />
                <Mic size={17} />
              </span>
              <strong>카메라·마이크</strong>
              <span>{permissionStatus === '권한 확인 전' ? '준비 전' : permissionStatus}</span>
            </div>
            <button type="button" className="secondaryButton" onClick={requestPermissions}>
              <Camera size={17} />
              허용
            </button>
          </div>

          <label className="apiKeyField">
            <span>
              <KeyRound size={16} />
              OpenAI API Key(선택)
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={handleApiKeyChange}
              placeholder="sk-..."
              autoComplete="off"
            />
          </label>

          <div className="onboardingActions">
            <button type="button" className="secondaryButton" onClick={downloadTemplate}>
              <Download size={18} />
              다운
            </button>
            <button
              type="button"
              className="uploadButton"
              onClick={handleUploadClick}
              disabled={!mediaReady}
              title={mediaReady ? 'CSV 업로드' : '카메라와 마이크를 먼저 허용해주세요'}
            >
              <Upload size={18} />
              업로드
            </button>
            <input
              ref={fileInputRef}
              className="hiddenFileInput"
              type="file"
              accept=".csv,text/csv"
              onChange={handleUpload}
            />
          </div>

          {!speechSupported && <p className="notice">음성 인식 미지원 브라우저입니다.</p>}
          {error && <p className="errorText">{error}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="appShell practicePage">
      <section className="cameraPanel">
        <video ref={videoRef} autoPlay muted playsInline aria-label="카메라 미리보기" />
        {!hasLiveMediaTracks(cameraStream) && (
          <div className="cameraFallback">
            <Camera size={22} />
            <span>카메라 연결 대기</span>
          </div>
        )}
        <div className="phaseBadge">
          {phase === 'waiting' && `${countdown}초 후 시작`}
          {phase === 'answering' && `답변 중 ${answerTime}초`}
          {phase === 'result' && '결과 확인'}
        </div>
      </section>

      <section className={`interviewPanel ${phase}Panel`}>
        <div className="questionHeader">
          <div>
            <div className="sessionProgress" aria-label="면접 진행 상태">
              <Sparkles size={14} aria-hidden="true" />
              <span className={phase === 'waiting' ? 'active' : ''}>준비</span>
              <span className={phase === 'answering' ? 'active' : ''}>답변</span>
              <span className={phase === 'result' ? 'active' : ''}>리뷰</span>
            </div>
          </div>
          <button
            type="button"
            className="textButton iconButton"
            onClick={resetApp}
            aria-label="처음으로 돌아가기"
            title="처음으로 돌아가기"
          >
            <Home size={16} />
          </button>
        </div>

        <h1>{currentItem?.question}</h1>

        {phase === 'waiting' && (
          <div className="statusBox">
            <strong>{countdown}</strong>
            <span>질문을 보고 답변을 준비하세요.</span>
          </div>
        )}

        {phase === 'answering' && (
          <div className="answeringBox">
            <div className="timerBar" aria-hidden="true">
              <span style={{ width: `${(answerTime / ANSWER_SECONDS) * 100}%` }} />
            </div>
            <p>{shownTranscript || '말하면 여기에 한국어 텍스트가 표시됩니다.'}</p>
            <button type="button" className="secondaryButton" onClick={finishAnswer}>
              <CheckCircle2 size={17} />
              답변 종료
            </button>
          </div>
        )}

        {phase === 'result' && (
          <div className="resultGrid">
            <article className="reportCard answerReport">
              <div className="reportHeader">
                <h2>내 답변</h2>
                <span>STT</span>
              </div>
              <textarea
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="음성 인식 결과가 없으면 직접 입력하세요."
              />
            </article>
            <article className="reportCard">
              <div className="reportHeader">
                <h2>예상 답변</h2>
                <span>CSV</span>
              </div>
              <p>{currentItem?.expectedAnswer}</p>
            </article>
            {apiKey.trim() && (
              <article className="feedbackPanel reportCard">
                <div className="feedbackHeader">
                  <div className="reportHeader">
                    <h2>AI 피드백</h2>
                    <span>AI</span>
                  </div>
                  <button
                    type="button"
                    className="secondaryButton"
                    onClick={requestAiFeedback}
                    disabled={!canRequestFeedback || feedbackStatus === 'loading'}
                  >
                    <Sparkles size={17} />
                    {feedbackStatus === 'loading' ? '분석 중' : 'AI 피드백 받기'}
                  </button>
                </div>
                <div className={`feedbackBody ${feedback ? 'hasFeedback' : ''}`}>
                  {feedback ||
                    '버튼을 누르면 질문, 예상 답변, 내 답변을 바탕으로 피드백을 생성합니다.'}
                </div>
              </article>
            )}
            <div className="resultActions">
              <button
                type="button"
                className="secondaryButton"
                onClick={handleRetake}
                disabled={retakeUsed}
              >
                <RotateCcw size={17} />
                다시 말하기 {retakeUsed ? '완료' : '1회'}
              </button>
              <button type="button" className="primaryButton" onClick={handleNextQuestion}>
                <ArrowRight size={18} />
                다음 질문
              </button>
            </div>
          </div>
        )}

        {error && <p className="errorText">{error}</p>}
      </section>
    </main>
  )
}

export default App

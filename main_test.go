package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/resend/resend-go/v4"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type deliveryCall struct {
	link      string
	recipient string
}

type recordingDeliverer struct {
	status int
	err    error
	calls  chan deliveryCall
}

func (d *recordingDeliverer) Deliver(
	_ context.Context,
	link string,
	recipient string,
) (int, error) {
	d.calls <- deliveryCall{link: link, recipient: recipient}
	return d.status, d.err
}

func newTestServer(t *testing.T, deliveryStatus int) (*Server, *recordingDeliverer, *httptest.Server) {
	t.Helper()
	deliverer := &recordingDeliverer{
		status: deliveryStatus,
		calls:  make(chan deliveryCall, 1),
	}
	server := NewServer(deliverer, log.New(io.Discard, "", 0))
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, deliverer, httpServer
}

func dialPeer(t *testing.T, serverURL, id, role string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(serverURL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial WebSocket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	writeMessage(t, conn, "connect", map[string]string{"id": id, "role": role})
	return conn
}

func writeMessage(t *testing.T, conn *websocket.Conn, messageType string, payload any) {
	t.Helper()
	if err := conn.WriteJSON(map[string]any{
		"type":    messageType,
		"payload": payload,
	}); err != nil {
		t.Fatalf("write %s: %v", messageType, err)
	}
}

func readMessage(t *testing.T, conn *websocket.Conn) Message {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	var message Message
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatalf("read WebSocket message: %v", err)
	}
	return message
}

func readStatus(t *testing.T, conn *websocket.Conn, expectedState string) OfferStatusPayload {
	t.Helper()
	message := readMessage(t, conn)
	if message.Type != "offer.status" {
		t.Fatalf("message type = %q, want offer.status", message.Type)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(message.Payload, &fields); err != nil {
		t.Fatalf("decode status fields: %v", err)
	}
	if len(fields) != 2 || fields["state"] == nil || fields["http_status"] == nil {
		t.Fatalf("offer.status payload fields = %v, want only state and http_status", fields)
	}
	var status OfferStatusPayload
	if err := json.Unmarshal(message.Payload, &status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if status.State != expectedState {
		t.Fatalf("status state = %q, want %q", status.State, expectedState)
	}
	return status
}

func readPeerReady(t *testing.T, conn *websocket.Conn) PeerReadyPayload {
	t.Helper()
	message := readMessage(t, conn)
	if message.Type != "peer-ready" {
		t.Fatalf("message type = %q, want peer-ready", message.Type)
	}
	var payload PeerReadyPayload
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		t.Fatalf("decode peer-ready: %v", err)
	}
	return payload
}

func TestDeliveryFailureReportsChosenTransport(t *testing.T) {
	server, deliverer, httpServer := newTestServer(t, http.StatusNotImplemented)
	deliverer.err = errors.New("phone transport unavailable")
	operator := dialPeer(t, httpServer.URL, "op-test", "operator")

	writeMessage(t, operator, "join.offer", map[string]string{
		"client_phone": "+15550001234",
	})
	<-deliverer.calls
	readStatus(t, operator, "challenge-created")
	status := readStatus(t, operator, "delivery.phone.failed")
	if status.HTTPStatus != http.StatusNotImplemented {
		t.Fatalf("delivery status = %d, want %d", status.HTTPStatus, http.StatusNotImplemented)
	}

	server.room.mu.Lock()
	challenge := server.room.Challenge
	server.room.mu.Unlock()
	if challenge != nil {
		t.Fatal("challenge remained in memory after delivery failure")
	}
}

func TestRequestedMediaDefaultsAndForcesAudio(t *testing.T) {
	defaultMedia := (JoinOfferPayload{}).requestedMedia()
	if !defaultMedia.Audio || !defaultMedia.Video {
		t.Fatalf("default media = %#v, want audio and video", defaultMedia)
	}

	audioOnly := (JoinOfferPayload{Media: MediaProfile{Audio: true}}).requestedMedia()
	if !audioOnly.Audio || audioOnly.Video {
		t.Fatalf("audio-only media = %#v", audioOnly)
	}

	videoRequest := (JoinOfferPayload{Media: MediaProfile{Video: true}}).requestedMedia()
	if !videoRequest.Audio || !videoRequest.Video {
		t.Fatalf("video request = %#v, want forced audio with video", videoRequest)
	}
}

func TestResendDelivererUsesSiblingDeliveryEmailSlice(t *testing.T) {
	type emailRequest struct {
		From    string   `json:"from"`
		To      []string `json:"to"`
		Subject string   `json:"subject"`
		HTML    string   `json:"html"`
	}

	requests := make(chan emailRequest, 1)
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body emailRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode Resend request: %v", err)
		}
		requests <- body

		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"id":"email-test"}`)),
			Request:    request,
		}, nil
	})}
	deliverer := &ResendDeliverer{
		Client: resend.NewCustomClient(httpClient, "test-key"),
		From:   "relay-center@cento92.com",
	}

	link := "http://dig.cento92/client#challenge-token"
	status, err := deliverer.Deliver(context.Background(), link, "client@example.test")
	if err != nil {
		t.Fatalf("deliver email: %v", err)
	}
	if status != http.StatusAccepted {
		t.Fatalf("delivery status = %d, want %d", status, http.StatusAccepted)
	}

	request := <-requests
	if request.From != "relay-center@cento92.com" {
		t.Fatalf("from = %q", request.From)
	}
	if len(request.To) != 1 || request.To[0] != "client@example.test" {
		t.Fatalf("to = %#v", request.To)
	}
	if !strings.Contains(request.HTML, link) {
		t.Fatal("delivery email does not contain the challenge link")
	}
}

func TestResendDelivererReportsPhoneAsUnsupported(t *testing.T) {
	deliverer := &ResendDeliverer{}
	status, err := deliverer.Deliver(
		context.Background(),
		"http://dig.cento92/client#challenge-token",
		"+15550001234",
	)
	if err == nil {
		t.Fatal("phone delivery unexpectedly succeeded")
	}
	if status != http.StatusNotImplemented {
		t.Fatalf("phone status = %d, want %d", status, http.StatusNotImplemented)
	}
}

func TestBootstrapOnlyAcceptsPrivateSources(t *testing.T) {
	server, _, _ := newTestServer(t, http.StatusAccepted)

	privateRequest := httptest.NewRequest(http.MethodGet, "/bootstrap", nil)
	privateRequest.RemoteAddr = "10.20.30.40:1234"
	privateResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(privateResponse, privateRequest)

	if privateResponse.Code != http.StatusFound {
		t.Fatalf("private status = %d, want %d", privateResponse.Code, http.StatusFound)
	}
	if location := privateResponse.Header().Get("Location"); location != defaultOperatorURL {
		t.Fatalf("redirect = %q, want %q", location, defaultOperatorURL)
	}

	publicRequest := httptest.NewRequest(http.MethodGet, "/bootstrap", nil)
	publicRequest.RemoteAddr = "203.0.113.10:1234"
	publicResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(publicResponse, publicRequest)

	if publicResponse.Code != http.StatusNotFound {
		t.Fatalf("public status = %d, want %d", publicResponse.Code, http.StatusNotFound)
	}
}

func TestBootstrapReturnsEmbeddableOperatorConfiguration(t *testing.T) {
	server, _, _ := newTestServer(t, http.StatusAccepted)
	request := httptest.NewRequest(http.MethodGet, "https://sig.example.test/bootstrap", nil)
	request.RemoteAddr = "10.20.30.40:1234"
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Origin", "https://apex.cento92.com")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("bootstrap status = %d, want %d", response.Code, http.StatusOK)
	}
	if origin := response.Header().Get("Access-Control-Allow-Origin"); origin != "https://apex.cento92.com" {
		t.Fatalf("allowed origin = %q", origin)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("cache control = %q, want no-store", cacheControl)
	}

	var config BootstrapConfig
	if err := json.NewDecoder(response.Body).Decode(&config); err != nil {
		t.Fatalf("decode bootstrap: %v", err)
	}
	if config.ModuleURL != "https://sig.example.test/op/app.js" {
		t.Fatalf("module URL = %q", config.ModuleURL)
	}
	if config.StylesheetURL != "https://sig.example.test/shared/app.css" {
		t.Fatalf("stylesheet URL = %q", config.StylesheetURL)
	}
	if config.SignalingURL != "wss://sig.example.test/ws" {
		t.Fatalf("signaling URL = %q", config.SignalingURL)
	}
}

func TestEmbeddedOperatorAssetsEnforceAllowedOrigins(t *testing.T) {
	server, _, _ := newTestServer(t, http.StatusAccepted)
	allowedRequest := httptest.NewRequest(http.MethodGet, "/op/app.js", nil)
	allowedRequest.Header.Set("Origin", "https://apex.cento92.com")
	allowedResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(allowedResponse, allowedRequest)
	if allowedResponse.Code != http.StatusOK {
		t.Fatalf("allowed asset status = %d, want %d", allowedResponse.Code, http.StatusOK)
	}
	if origin := allowedResponse.Header().Get("Access-Control-Allow-Origin"); origin != "https://apex.cento92.com" {
		t.Fatalf("asset allowed origin = %q", origin)
	}

	request := httptest.NewRequest(http.MethodGet, "/op/app.js", nil)
	request.Header.Set("Origin", "https://untrusted.example.test")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("asset status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestDevelopmentRCOriginIsAllowed(t *testing.T) {
	server, _, _ := newTestServer(t, http.StatusAccepted)
	request := httptest.NewRequest(http.MethodGet, "/op/app.js", nil)
	request.Header.Set("Origin", "https://rc-dev.cento92.com")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("development asset status = %d, want %d", response.Code, http.StatusOK)
	}
	if origin := response.Header().Get("Access-Control-Allow-Origin"); origin != "https://rc-dev.cento92.com" {
		t.Fatalf("development allowed origin = %q", origin)
	}
}

func TestOperatorCapacityRejectsBootstrapAndSecondWebSocket(t *testing.T) {
	server, deliverer, httpServer := newTestServer(t, http.StatusAccepted)
	first := dialPeer(t, httpServer.URL, "op-first", "operator")
	second := dialPeer(t, httpServer.URL, "op-second", "operator")

	status := readStatus(t, second, operatorCapacityState)
	if status.HTTPStatus != http.StatusConflict {
		t.Fatalf("capacity status = %d, want %d", status.HTTPStatus, http.StatusConflict)
	}
	if err := second.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set second operator read deadline: %v", err)
	}
	_, _, err := second.ReadMessage()
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) {
		t.Fatalf("second operator close error = %v, want WebSocket close", err)
	}
	if closeError.Code != websocket.CloseTryAgainLater {
		t.Fatalf(
			"second operator close code = %d, want %d",
			closeError.Code,
			websocket.CloseTryAgainLater,
		)
	}

	server.room.mu.Lock()
	activeOperator := server.room.Operator
	server.room.mu.Unlock()
	if activeOperator == nil || activeOperator.ID != "op-first" {
		t.Fatalf("active operator = %#v, want op-first", activeOperator)
	}

	request := httptest.NewRequest(http.MethodGet, "/bootstrap", nil)
	request.RemoteAddr = "10.20.30.40:1234"
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("bootstrap at capacity = %d, want %d", response.Code, http.StatusConflict)
	}
	if !strings.Contains(response.Body.String(), "another operator is already connected") {
		t.Fatalf("bootstrap capacity response = %q", response.Body.String())
	}

	writeMessage(t, first, "join.offer", map[string]string{
		"client_email": "client@example.test",
	})
	<-deliverer.calls
	if status := readStatus(t, first, "challenge-created"); status.HTTPStatus != http.StatusAccepted {
		t.Fatalf("first operator status = %d, want %d", status.HTTPStatus, http.StatusAccepted)
	}
}

func TestJoinChallengeGatesExistingSignalingFlow(t *testing.T) {
	server, deliverer, httpServer := newTestServer(t, http.StatusAccepted)
	operator := dialPeer(t, httpServer.URL, "op-test", "operator")

	writeMessage(t, operator, "join.offer", map[string]any{
		"client_phone": "",
		"client_email": "client@example.test",
		"data":         map[string]string{"incident": "test"},
		"media":        map[string]bool{"audio": true, "video": false},
	})

	call := <-deliverer.calls
	if call.recipient != "client@example.test" {
		t.Fatalf("delivery recipient = %q", call.recipient)
	}
	if !strings.HasPrefix(call.link, server.clientURL+"#") {
		t.Fatalf("delivery link does not use client fragment")
	}
	token := strings.TrimPrefix(call.link, server.clientURL+"#")
	if token == "" {
		t.Fatal("delivery challenge is empty")
	}

	if status := readStatus(t, operator, "challenge-created"); status.HTTPStatus != http.StatusAccepted {
		t.Fatalf("challenge-created HTTP status = %d", status.HTTPStatus)
	}
	readStatus(t, operator, "delivery.email.sent")

	clientResponse, err := http.Get(httpServer.URL + "/client")
	if err != nil {
		t.Fatalf("request client app: %v", err)
	}
	_ = clientResponse.Body.Close()
	readStatus(t, operator, "client-app-requested")

	user := dialPeer(t, httpServer.URL, "user-test", "user")
	writeMessage(t, user, "join.offer", map[string]string{
		"solved_challenge": token,
	})

	readStatus(t, operator, "challenge-verified")
	readStatus(t, user, "challenge-verified")
	operatorReady := readPeerReady(t, operator)
	if !operatorReady.Media.Audio || operatorReady.Media.Video {
		t.Fatalf("operator peer media = %#v, want audio-only", operatorReady.Media)
	}
	userReady := readPeerReady(t, user)
	if !userReady.Media.Audio || userReady.Media.Video {
		t.Fatalf("user peer media = %#v, want audio-only", userReady.Media)
	}

	writeMessage(t, user, "peer-retry-request", nil)
	if message := readMessage(t, operator); message.Type != "peer-retry-request" {
		t.Fatalf("operator retry message = %q, want peer-retry-request", message.Type)
	}
	writeMessage(t, operator, "peer-retry", nil)
	if message := readMessage(t, user); message.Type != "peer-retry" {
		t.Fatalf("user retry message = %q, want peer-retry", message.Type)
	}
	writeMessage(t, user, "media.status", map[string]bool{
		"audio_enabled":   false,
		"video_available": false,
		"video_enabled":   false,
	})
	if message := readMessage(t, operator); message.Type != "media.status" {
		t.Fatalf("operator media message = %q, want media.status", message.Type)
	}

	writeMessage(t, operator, "video-offer", map[string]string{"type": "offer", "sdp": "test"})
	if message := readMessage(t, user); message.Type != "video-offer" {
		t.Fatalf("forwarded message = %q, want video-offer", message.Type)
	}

	server.room.mu.Lock()
	challenge := server.room.Challenge
	ready := server.room.Ready
	server.room.mu.Unlock()
	if challenge != nil {
		t.Fatal("challenge remained in memory after successful verification")
	}
	if !ready {
		t.Fatal("room is not ready after successful verification")
	}
}

func TestFailedChallengeIsReportedAndDeleted(t *testing.T) {
	server, deliverer, httpServer := newTestServer(t, http.StatusOK)
	operator := dialPeer(t, httpServer.URL, "op-test", "operator")
	writeMessage(t, operator, "join.offer", map[string]string{
		"client_email": "client@example.test",
	})
	<-deliverer.calls
	readStatus(t, operator, "challenge-created")
	readStatus(t, operator, "delivery.email.sent")

	user := dialPeer(t, httpServer.URL, "user-test", "user")
	writeMessage(t, user, "join.offer", map[string]string{
		"solved_challenge": "wrong-challenge",
	})

	if status := readStatus(t, operator, "challenge-failed"); status.HTTPStatus != http.StatusUnauthorized {
		t.Fatalf("failure HTTP status = %d", status.HTTPStatus)
	}
	readStatus(t, user, "challenge-failed")

	server.room.mu.Lock()
	challenge := server.room.Challenge
	ready := server.room.Ready
	server.room.mu.Unlock()
	if challenge != nil {
		t.Fatal("failed challenge remained in memory")
	}
	if ready {
		t.Fatal("room became ready after failed challenge")
	}
}

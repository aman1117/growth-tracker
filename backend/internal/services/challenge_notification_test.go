package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNotificationService_ChallengeTriggers(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newNotificationService(db)
	actorMeta := func(recipient uint) models.NotificationMetadata {
		return models.NotificationMetadata{
			"challenge_id": float64(12), "challenge_title": "Study 📚", "actor_id": float64(9),
			"actor_username": "frank", "actor_avatar": "https://img/f.jpg",
		}
	}

	cases := []struct {
		name     string
		notify   func(s *NotificationService, recipient uint) error
		typ      models.NotificationType
		title    string
		body     string
		metadata func(recipient uint) models.NotificationMetadata
		pushKey  string // with the recipient's ID as its only verb
		deepLink string
	}{
		{
			name: "invite",
			notify: func(s *NotificationService, recipient uint) error {
				return s.NotifyChallengeInvite(ctx, recipient, 9, "frank", "https://img/f.jpg", 12, "Study 📚", "K7Q2M9XA")
			},
			typ: models.NotifTypeChallengeInvite, title: "Challenge invite 🏆", body: "frank invited you to “Study 📚”",
			metadata: func(recipient uint) models.NotificationMetadata {
				m := actorMeta(recipient)
				m["invite_code"] = "K7Q2M9XA"
				return m
			},
			pushKey: "challenge_invite:%d:9:12", deepLink: "/c/K7Q2M9XA",
		},
		{
			name: "joined",
			notify: func(s *NotificationService, recipient uint) error {
				return s.NotifyChallengeJoined(ctx, recipient, 9, "frank", "https://img/f.jpg", 12, "Study 📚")
			},
			typ: models.NotifTypeChallengeJoined, title: "New challenger 🏁", body: "frank joined “Study 📚”",
			metadata: actorMeta, pushKey: "challenge_joined:%d:9:12", deepLink: "/challenges/12",
		},
		{
			name: "cheer",
			notify: func(s *NotificationService, recipient uint) error {
				return s.NotifyChallengeCheer(ctx, recipient, 9, "frank", "https://img/f.jpg", 12, "Study 📚", "2026-03-09")
			},
			typ: models.NotifTypeChallengeCheer, title: "You got a cheer 👏", body: "frank cheered you on in “Study 📚”",
			metadata: actorMeta, pushKey: "challenge_cheer:%d:9:12:2026-03-09", deepLink: "/challenges/12",
		},
		{
			name: "ended, completed",
			notify: func(s *NotificationService, recipient uint) error {
				return s.NotifyChallengeEnded(ctx, recipient, 12, "Study 📚", 2, 17, 21, true)
			},
			typ: models.NotifTypeChallengeEnded, title: "Challenge complete 🎉",
			body: "“Study 📚” is over: you finished #2 with 17/21 days.",
			metadata: func(uint) models.NotificationMetadata {
				return models.NotificationMetadata{
					"challenge_id": float64(12), "challenge_title": "Study 📚", "rank": float64(2),
					"days_met": float64(17), "days_possible": float64(21), "completed": true,
				}
			},
			pushKey: "challenge_ended:%d:12", deepLink: "/challenges/12",
		},
		{
			name: "ended, not completed",
			notify: func(s *NotificationService, recipient uint) error {
				return s.NotifyChallengeEnded(ctx, recipient, 12, "Study 📚", 5, 3, 21, false)
			},
			typ: models.NotifTypeChallengeEnded, title: "Challenge ended",
			body: "“Study 📚” is over: you finished #5 with 3/21 days.",
			metadata: func(uint) models.NotificationMetadata {
				return models.NotificationMetadata{
					"challenge_id": float64(12), "challenge_title": "Study 📚", "rank": float64(5),
					"days_met": float64(3), "days_possible": float64(21), "completed": false,
				}
			},
			pushKey: "challenge_ended:%d:12", deepLink: "/challenges/12",
		},
	}

	for i, tc := range cases {
		recipient := uint(100*i + 1)
		t.Run(tc.name, func(t *testing.T) {
			mr := startRedis(t)
			mr.Set(unreadKey(recipient), "4")
			publisher := installPushPublisher(t, 10)

			require.NoError(t, tc.notify(svc, recipient))
			require.NoError(t, tc.notify(svc, recipient), "a duplicate is skipped")

			notifs := notificationsOf(t, db, recipient)
			require.Len(t, notifs, 1)
			n := notifs[0]
			assert.Equal(t, tc.typ, n.Type)
			assert.Equal(t, tc.title, n.Title)
			assert.Equal(t, tc.body, n.Body)
			assert.Equal(t, tc.metadata(recipient), n.Metadata)
			assert.False(t, mr.Exists(unreadKey(recipient)), "the cached unread count is invalidated")

			pushes := queuedPushes(t, publisher)
			require.Len(t, pushes, 1)
			assert.Equal(t, fmt.Sprintf(tc.pushKey, recipient), pushes[0].DedupeKey)
			assert.Equal(t, tc.deepLink, pushes[0].DeepLink)
			assert.Equal(t, tc.title, pushes[0].Title)
			assert.EqualValues(t, n.ID, pushes[0].Data["notification_id"])
		})

		t.Run(tc.name+" push queue full", func(t *testing.T) {
			logs := observeChallengeLogs(t)
			installPushPublisher(t, 0)
			require.NoError(t, tc.notify(svc, recipient+1), "the in-app notification is still delivered")
			assert.Len(t, notificationsOf(t, db, recipient+1), 1)
			assert.Equal(t, 1, logs.FilterMessage("Failed to publish push notification; the in-app notification is still delivered").Len())
		})

		t.Run(tc.name+" dedupe failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notification_dedupes")))
			require.ErrorIs(t, tc.notify(broken, recipient+2), errInjected)
		})

		t.Run(tc.name+" notification failure", func(t *testing.T) {
			broken := newNotificationService(faultyDB(t, failingOn("create", "notifications")))
			require.ErrorIs(t, tc.notify(broken, recipient+3), errInjected)
			assert.Empty(t, notificationsOf(t, db, recipient+3))
			require.NoError(t, tc.notify(svc, recipient+3), "nothing was half-stored: a retry delivers it")
			assert.Len(t, notificationsOf(t, db, recipient+3), 1)
		})
	}

	t.Run("cheers are deduplicated per day", func(t *testing.T) {
		recipient := uint(9001)
		for _, date := range []string{"2026-03-09", "2026-03-09", "2026-03-10"} {
			require.NoError(t, svc.NotifyChallengeCheer(ctx, recipient, 9, "frank", "", 12, "Study", date))
		}
		assert.Len(t, notificationsOf(t, db, recipient), 2)
		require.NoError(t, svc.NotifyChallengeCheer(ctx, recipient, 10, "gina", "", 12, "Study", "2026-03-10"))
		assert.Len(t, notificationsOf(t, db, recipient), 3, "another cheerer")
	})

	t.Run("one ended notification per challenge", func(t *testing.T) {
		recipient := uint(9002)
		require.NoError(t, svc.NotifyChallengeEnded(ctx, recipient, 12, "Study", 1, 3, 3, true))
		require.NoError(t, svc.NotifyChallengeEnded(ctx, recipient, 12, "Study", 2, 2, 3, false))
		require.NoError(t, svc.NotifyChallengeEnded(ctx, recipient, 13, "Other", 1, 3, 3, true))
		notifs := notificationsOf(t, db, recipient)
		require.Len(t, notifs, 2)
		assert.Equal(t, "Challenge complete 🎉", notifs[0].Title, "the first one wins")
	})
}

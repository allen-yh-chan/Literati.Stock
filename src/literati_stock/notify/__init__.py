"""Signal notification: channel abstraction, Discord channel, dispatch service."""

from literati_stock.notify.base import NotificationChannel, SignalDispatch
from literati_stock.notify.channels.discord import (
    DiscordNotificationError,
    DiscordWebhookChannel,
)
from literati_stock.notify.service import NotificationService

__all__ = [
    "DiscordNotificationError",
    "DiscordWebhookChannel",
    "NotificationChannel",
    "NotificationService",
    "SignalDispatch",
]

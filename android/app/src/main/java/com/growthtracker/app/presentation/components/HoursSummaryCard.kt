package com.growthtracker.app.presentation.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.growthtracker.app.presentation.theme.StreakGold

private val SuccessGreen = Color(0xFF22C55E)
private val WarningRed = Color(0xFFEF4444)

private fun formatHours(hours: Float): String {
    return if (hours % 1f == 0f) {
        hours.toInt().toString()
    } else {
        String.format(java.util.Locale.US, "%.2f", hours)
    }
}

@Composable
fun HoursSummaryCard(
    totalHours: Float,
    modifier: Modifier = Modifier
) {
    val maxHours = 24f
    val percentage = (totalHours / maxHours).coerceIn(0f, 1f)
    val remainingHours = (maxHours - totalHours).coerceAtLeast(0f)

    val animatedProgress by animateFloatAsState(
        targetValue = percentage,
        animationSpec = tween(durationMillis = 500),
        label = "progress"
    )

    val statusColor = when {
        totalHours >= maxHours -> SuccessGreen
        totalHours >= 18f -> StreakGold
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    val statusIcon: ImageVector = when {
        totalHours >= maxHours -> Icons.Default.CheckCircle
        totalHours > maxHours -> Icons.Default.Warning
        else -> Icons.Default.AccessTime
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        shape = RoundedCornerShape(12.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Duotone Icon Container
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(statusColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = statusIcon,
                    contentDescription = null,
                    tint = statusColor,
                    modifier = Modifier.size(24.dp)
                )
            }

            Spacer(modifier = Modifier.width(16.dp))

            // Content
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                // Header Row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Hours Logged",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Text(
                        text = buildAnnotatedString {
                            withStyle(
                                style = SpanStyle(
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            ) {
                                append(formatHours(totalHours))
                            }
                            withStyle(
                                style = SpanStyle(
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            ) {
                                append("/${maxHours.toInt()}h")
                            }
                        }
                    )
                }

                // Progress Bar
                LinearProgressIndicator(
                    progress = { animatedProgress },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp)),
                    color = statusColor,
                    trackColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f),
                    strokeCap = StrokeCap.Round
                )

                // Status Text
                Text(
                    text = when {
                        totalHours >= maxHours -> "✓ Day fully logged"
                        totalHours > maxHours -> "⚠ Over 24 hours logged"
                        else -> "${formatHours(remainingHours)}h remaining to log"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (totalHours >= maxHours) SuccessGreen 
                           else if (totalHours > maxHours) WarningRed 
                           else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (totalHours >= maxHours || totalHours > maxHours) FontWeight.SemiBold else FontWeight.Normal
                )
            }
        }
    }
}

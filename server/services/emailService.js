const nodemailer = require('nodemailer');
const emailTemplates = require('../utils/emailTemplates');

/**
 * Email Service for FIRA
 * Handles all email sending functionality
 */

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialize();
  }

  /**
   * Initialize email transporter with SMTP configuration
   */
  initialize() {
    try {
      // Check if email service is disabled
      if (process.env.EMAIL_DISABLE === 'true') {
        console.log('⚠️ Email service disabled via EMAIL_DISABLE environment variable.');
        this.transporter = {
          sendMail: async (mailOptions) => {
            console.log(`✉️ [Mock Email Bypassed] To: ${mailOptions.to}, Subject: ${mailOptions.subject}`);
            return { messageId: 'disabled-mock-id' };
          },
          verify: async () => {
            console.log('✉️ [Mock Email Verify] Connection verified (mocked)');
            return true;
          }
        };
        return;
      }

      // Validate required environment variables
      if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.error('❌ Missing SMTP configuration. Please check your .env file.');
        console.error('Required: SMTP_HOST, SMTP_USER, SMTP_PASS');
        return;
      }

      const smtpConfig = {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: {
          rejectUnauthorized: false
        },
        // Add debug logging
        logger: process.env.NODE_ENV === 'development',
        debug: process.env.NODE_ENV === 'development'
      };

      this.transporter = nodemailer.createTransport(smtpConfig);

      console.log('✅ Email service initialized successfully');
      console.log(`📧 SMTP Host: ${process.env.SMTP_HOST}`);
      console.log(`📧 SMTP Port: ${smtpConfig.port}`);
      console.log(`📧 SMTP User: ${process.env.SMTP_USER}`);
      console.log(`📧 Secure: ${smtpConfig.secure}`);
    } catch (error) {
      console.error('❌ Email service initialization failed:', error.message);
    }
  }

  /**
   * Send OTP verification email
   * @param {string} email - Recipient email
   * @param {string} otp - 4-digit OTP code
   * @param {string} name - User's name
   * @returns {Promise<boolean>} - Success status
   */
  async sendOTPEmail(email, otp, name) {
    try {
      if (!this.transporter) {
        throw new Error('Email service not initialized');
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `${otp} is your FIRA verification code`,
        html: emailTemplates.otpVerification(name, otp),
        text: `Hey ${name}!\n\nYour FIRA verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, please ignore this email.\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ OTP email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send OTP email:', error.message);
      throw new Error('Failed to send verification email. Please try again.');
    }
  }

  /**
   * Send welcome email after successful verification
   * @param {string} email - Recipient email
   * @param {string} name - User's name
   * @param {string} role - User's role
   * @returns {Promise<boolean>} - Success status
   */
  async sendWelcomeEmail(email, name, role) {
    try {
      if (!this.transporter) {
        throw new Error('Email service not initialized');
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: 'Welcome to FIRA! 🎉',
        html: emailTemplates.welcome(name, role),
        text: `Hey ${name}!\n\nWelcome to FIRA! Your email has been successfully verified.\n\nStart exploring amazing venues and events now!\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Welcome email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send welcome email:', error.message);
      // Don't throw error for welcome email, it's not critical
      return false;
    }
  }

  /**
   * Verify email service configuration
   * @returns {Promise<boolean>} - Verification status
   */
  async verifyConnection() {
    try {
      if (!this.transporter) {
        return false;
      }
      await this.transporter.verify();
      console.log('✅ Email service connection verified');
      return true;
    } catch (error) {
      console.error('❌ Email service verification failed:', error.message);
      return false;
    }
  }
  /**
   * Send ticket confirmation email
   * @param {string} email - Recipient email
   * @param {string} name - User's name
   * @param {object} event - Event details
   * @param {object} ticket - Ticket details
   * @returns {Promise<boolean>} - Success status
   */
  async sendTicketEmail(email, name, event, ticket) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping ticket email.');
        return false;
      }

      // The QR goes as an inline attachment the HTML points at (cid:). Most mail
      // apps block data: images, so the code showed as an empty box.
      const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(ticket.qrCode || ''));
      const qr = match
        ? { filename: `${ticket.ticketId || 'ticket'}-qr.png`, content: match[2], encoding: 'base64', contentType: match[1], cid: `ticket-qr-${ticket.ticketId || 'code'}@fira` }
        : null;

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira Tickets'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `Your Ticket for ${event.name} 🎟️`,
        html: emailTemplates.ticketConfirmation(name, event, ticket, { qrSrc: qr ? `cid:${qr.cid}` : undefined }),
        attachments: qr ? [qr] : [],
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Ticket email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send ticket email:', error.message);
      return false;
    }
  }

  /**
   * Send password reset OTP email
   * @param {string} email - Recipient email
   * @param {string} otp - Reset code
   * @param {string} name - User's name
   * @returns {Promise<boolean>} - Success status
   */
  async sendPasswordResetEmail(email, otp, name) {
    try {
      if (!this.transporter) {
        throw new Error('Email service not initialized');
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `${otp} - Reset your FIRA password`,
        html: emailTemplates.passwordReset(name, otp),
        text: `Hey ${name}!\n\nYour FIRA password reset code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, please ignore this email.\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Password reset email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send password reset email:', error.message);
      throw new Error('Failed to send password reset email. Please try again.');
    }
  }

  /**
   * Send password changed confirmation email
   * @param {string} email - Recipient email
   * @param {string} name - User's name
   * @returns {Promise<boolean>} - Success status
   */
  /**
   * Tell the account holder their payout bank details changed. This is the signal
   * that surfaces a takeover trying to redirect earnings, so it is sent for every
   * change (added, removed, default switched, details edited).
   */
  async sendPayoutAccountChangedEmail(email, name, change) {
    try {
      if (!this.transporter) {
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: 'Your FIRA payout account was changed',
        html: emailTemplates.payoutAccountChanged(name, change),
        text: `Hey ${name || 'there'}!\n\nThe bank account your FIRA earnings are paid to was just changed: ${change}.\n\nIf you didn't make this change, change your password and contact us immediately.\n\n- FIRA Team`
      };

      await this.transporter.sendMail(mailOptions);
      return true;
    } catch (error) {
      console.error('❌ Failed to send payout account changed email:', error.message);
      return false;
    }
  }

  async sendPasswordChangedEmail(email, name) {
    try {
      if (!this.transporter) {
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: 'Your FIRA password was changed',
        html: emailTemplates.passwordChanged(name),
        text: `Hey ${name}!\n\nYour FIRA account password was successfully changed.\n\nIf you didn't make this change, please contact us immediately.\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Password changed email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send password changed email:', error.message);
      return false;
    }
  }

  /**
   * Send venue booking notification email to owner
   * @param {string} email - Venue owner's email
   * @param {string} ownerName - Venue owner's name
   * @param {object} venue - Venue details
   * @param {object} booking - Booking details
   * @param {object} booker - Booker's info
   * @returns {Promise<boolean>} - Success status
   */
  async sendVenueBookingEmail(email, ownerName, venue, booking, booker) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping venue booking email.');
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `New Booking Request for ${venue.name} 🎉`,
        html: emailTemplates.venueBookingNotification(ownerName, venue, booking, booker),
        text: `Hey ${ownerName}!\n\nGreat news! Someone wants to book your venue ${venue.name}.\n\nBooking Details:\n- Date: ${new Date(booking.date).toLocaleDateString()}\n- Guests: ${booking.guestCount || 'Not specified'}\n- Total: ₹${booking.totalPrice || 'TBD'}\n\nFrom: ${booker.name} (${booker.email})\n\nAccept or decline it in your venue portal: ${process.env.CLIENT_URL || 'http://localhost:3000'}/venue-portal/bookings\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Venue booking notification email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send venue booking email:', error.message);
      return false;
    }
  }

  /**
   * Send event request notification email to venue owner
   * @param {string} email - Venue owner's email
   * @param {string} ownerName - Venue owner's name
   * @param {object} venue - Venue details
   * @param {object} event - Event details
   * @param {object} organizer - Organizer info
   * @returns {Promise<boolean>} - Success status
   */
  async sendEventRequestEmail(email, ownerName, venue, event, organizer) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping event request email.');
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `New Event Request for ${venue.name} 🎉`,
        html: emailTemplates.eventRequestNotification(ownerName, venue, event, organizer),
        text: `Hey ${ownerName}!\n\n${organizer.name} wants to host an event at your venue ${venue.name}.\n\nEvent: ${event.name}\nStarts: ${new Date(event.startDateTime).toLocaleString('en-IN')}\nEnds: ${new Date(event.endDateTime).toLocaleString('en-IN')}\n\nIf you approve, the organiser pays your venue price in full before the event goes live.\n\nReview it in your venue portal: ${process.env.CLIENT_URL || 'http://localhost:3000'}/venue-portal/events\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Event request notification email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send event request email:', error.message);
      return false;
    }
  }

  /**
   * Send brand activity notification email
   * @param {string} email - Recipient email
   * @param {string} userName - User's name
   * @param {string} brandName - Brand name
   * @param {string} activityType - Type of activity (brand_new_event, brand_new_post)
   * @param {object} data - Activity data (event or post details)
   * @returns {Promise<boolean>} - Success status
   */
  async sendBrandActivityEmail(email, userName, brandName, activityType, data) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping brand activity email.');
        return false;
      }

      let subject, html;
      
      if (activityType === 'brand_new_event') {
        subject = `🎉 ${brandName} just announced a new event!`;
        html = emailTemplates.brandNewEvent(userName, brandName, data.extra?.event || data);
      } else if (activityType === 'brand_new_post') {
        subject = `📢 New update from ${brandName}`;
        html = emailTemplates.brandNewPost(userName, brandName, data.extra?.post || data);
      } else {
        console.warn('Unknown brand activity type:', activityType);
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject,
        html,
        text: `Hey ${userName}, ${brandName} has new activity! Check it out on FIRA.`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Brand activity email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send brand activity email:', error.message);
      return false;
    }
  }

  /**
   * Send event reminder email (1 hour before event)
   * @param {string} email - Recipient email
   * @param {string} userName - User's name
   * @param {object} event - Event details
   * @param {object} ticket - Ticket details
   * @returns {Promise<boolean>} - Success status
   */
  async sendEventReminderEmail(email, userName, event, ticket) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping event reminder email.');
        return false;
      }

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: `⏰ ${event.name} starts in 1 hour!`,
        html: emailTemplates.eventReminder(userName, event, ticket),
        text: `Hey ${userName}!\n\nDon't forget - ${event.name} starts in 1 hour!\n\nYour ticket ID: ${ticket.ticketId}\n\nSee you there!\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Event reminder email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send event reminder email:', error.message);
      return false;
    }
  }

  /**
   * Send venue balance payment reminder email
   * @param {string} to - Recipient email
   * @param {string} name - Customer's name
   * @param {object} details - { venueName, daysLeft, balanceAmount, balanceDueAt, bookingId }
   * @returns {Promise<boolean>} - Success status
   */
  /**
   * Final notice, 2 days before the booking: pay the balance now, or cancel
   * (and get back what the venue's cancellation policy allows). After the
   * deadline - 24 hours before the booking - the booking is cancelled and the
   * deposit is forfeited.
   */
  async sendBalanceFinalNoticeEmail(to, name, details) {
    try {
      if (!this.transporter) {
        return false;
      }
      const { venueName, balanceAmount, balanceDueAt, bookingId } = details;
      const due = new Date(balanceDueAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const link = `${process.env.CLIENT_URL || 'http://localhost:3000'}/dashboard/bookings/${bookingId}`;
      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `Final notice: pay ₹${balanceAmount} or cancel your booking at ${venueName}`,
        html: emailTemplates.balanceFinalNotice(name, details),
        text: `Hey ${name || 'there'}!\n\nThe remaining ₹${balanceAmount} for your booking at ${venueName} is still unpaid.\nPay it by ${due} to keep your booking, or cancel before then to get back what the venue's cancellation policy allows.\nIf it is neither paid nor cancelled by ${due}, the booking is cancelled automatically and the deposit is not refunded.\n\n${link}\n\n- FIRA Team`
      };
      await this.transporter.sendMail(mailOptions);
      return true;
    } catch (error) {
      console.error('❌ Failed to send balance final notice email:', error.message);
      return false;
    }
  }

  /**
   * A short booking update to the guest with a link to the booking: accepted -
   * pay to confirm, your booking is tomorrow, and the like. `lines` are plain
   * text paragraphs (escaped here; venue names are user-entered).
   */
  async sendBookingUpdateEmail(to, name, { subject, heading, lines = [], bookingId, linkText = 'View booking' }) {
    try {
      if (!this.transporter || !to) {
        return false;
      }
      const link = `${process.env.CLIENT_URL || 'http://localhost:3000'}/dashboard/bookings/${bookingId}`;
      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject,
        html: emailTemplates.bookingUpdate(name, { heading, lines, link, linkText }),
        text: `Hey ${name || 'there'}!\n\n${lines.join('\n\n')}\n\n${link}\n\n- FIRA Team`
      };
      await this.transporter.sendMail(mailOptions);
      return true;
    } catch (error) {
      console.error('❌ Failed to send booking update email:', error.message);
      return false;
    }
  }

  async sendBalanceReminderEmail(to, name, details) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping balance reminder email.');
        return false;
      }

      const { venueName, daysLeft, balanceAmount, balanceDueAt } = details;
      const dayLabel = daysLeft === 1 ? 'day' : 'days';
      const dueDate = new Date(balanceDueAt).toLocaleDateString();

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `⏳ Balance due in ${daysLeft} ${dayLabel} for ${venueName}`,
        html: emailTemplates.balanceReminder(name, details),
        text: `Hey ${name}!\n\nA friendly reminder: the remaining balance for your booking at ${venueName} is due in ${daysLeft} ${dayLabel} (by ${dueDate}).\n\nAmount due: ₹${balanceAmount}\n\nPlease pay before the deadline to keep your booking - otherwise it will be cancelled and the deposit forfeited.\n\nPay now: ${process.env.CLIENT_URL || 'http://localhost:3000'}/dashboard/bookings\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Balance reminder email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send balance reminder email:', error.message);
      return false;
    }
  }

  /**
   * Send venue booking forfeiture email (auto-cancelled, deposit forfeited)
   * @param {string} to - Recipient email
   * @param {string} name - Customer's name
   * @param {object} details - { venueName, depositAmount, bookingId }
   * @returns {Promise<boolean>} - Success status
   */
  async sendBalanceForfeitEmail(to, name, details) {
    try {
      if (!this.transporter) {
        console.warn('⚠️ Email service not initialized, skipping balance forfeit email.');
        return false;
      }

      const { venueName, depositAmount } = details;

      const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Fira - Let\'s Celebrate'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `Your booking at ${venueName} was cancelled`,
        html: emailTemplates.balanceForfeit(name, details),
        text: `Hey ${name}!\n\nYour booking at ${venueName} has been automatically cancelled because the remaining balance was not paid by the deadline.\n\nThe 10% deposit of ₹${depositAmount} has been forfeited and is non-refundable, as per the payment schedule. The venue's date has been released for other customers.\n\n- FIRA Team`
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Balance forfeit email sent successfully:', info.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send balance forfeit email:', error.message);
      return false;
    }
  }
}

// Create singleton instance
const emailService = new EmailService();

module.exports = emailService;

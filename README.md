# License Plate Recognition Notifier

## What does this script do?

This script is designed to automate the process of recognizing vehicle license plates from images attached to incoming emails. It uses the Plate Recognizer API for accurate plate recognition and performs matching against a CSV database of authorized license plates. When a match is found, the script sends email notifications and, if applicable, makes Twilio calls to notify relevant parties.

## How does it work?

1. **Email Processing**: The script is triggered by incoming emails with attached images of license plates. It downloads the email content from a designated S3 bucket.

2. **Plate Recognition**: It utilizes the Plate Recognizer API to accurately recognize the license plate number from the attached image.

3. **Database Matching**: The script then compares the recognized license plate against a CSV database of authorized license plates. It performs both exact and fuzzy matching to find potential matches.

4. **Notifications**: When a match is found:
   - For exact matches: The script sends an email notification to a specified recipient.
   - For both exact and fuzzy matches: It also makes a Twilio call to a predefined phone number for immediate notification.

5. **Logging**: The script logs its actions and any errors for troubleshooting.

## How to Install and Update

1. **Dependencies**:
   - Ensure you have the necessary AWS credentials configured, including SES (Simple Email Service) and S3 (Simple Storage Service).
   - Set up a Plate Recognizer API token for plate recognition.
   - Create a Twilio account and obtain the required credentials (Account SID and Auth Token).

2. **Configuration**:
   - Set your AWS Lambda function with this script.
   - Configure the following parameters at the top of the script:
     - `plate_recognizer_token`: Your Plate Recognizer API token.
     - `ses_sender_email`: Your SES sender email address.
     - `twilio_phone_number`: Your Twilio phone number.
     - `twilio_account_sid`: Your Twilio Account SID.
     - `twilio_auth_token`: Your Twilio Auth Token.
     - `s3_bucket_name`: The name of your S3 bucket containing authorized license plates.
     - `s3_file_key`: The key (path) to the CSV file containing authorized license plates.
     - `fuzzy_match_threshold`: Threshold for fuzzy matching (adjust as needed).

3. **Deployment**:
   - Create an AWS Lambda function and upload this script.
   - Set up an S3 trigger to invoke the Lambda function when new emails are received.

4. **Testing and Monitoring**:
   - Test the Lambda function by sending emails with attached license plate images.
   - Monitor AWS CloudWatch logs for any issues.

5. **Updates**:
   - To update the script, modify the Lambda function with the latest code.
   - Ensure your dependencies and configurations remain up-to-date.

That's it! You now have an automated License Plate Recognition Notifier to enhance your security and notification systems.

Feel free to customize and adapt the script to your specific use case and requirements.

